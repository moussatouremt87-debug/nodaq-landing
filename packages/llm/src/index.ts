import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CLASSIFICATION_PROMPT,
  allowedTiers,
  classify,
} from "@nodaq/classifier";
import { withTenant } from "@nodaq/db";
import { SensitivityCategory, TenantId } from "@nodaq/shared";
import type { ModelGroup } from "@nodaq/shared";
import { SovereigntyViolationError } from "./errors.js";
import { chatCompletion, chatCompletionWithTools, embeddings } from "./litellm.js";
import type { AssistantTurn, ChatMessage, LoopMessage, ToolDefinition } from "./litellm.js";

export { SovereigntyViolationError } from "./errors.js";
export type { ChatMessage } from "./litellm.js";

/*
 * Sovereign model routing (blueprint §5.1/§5.2):
 *   classify -> policy(tenant) -> HARD GUARD -> LiteLLM call -> audit (hash only).
 * This module is the ONLY place business code calls a model from.
 */

/**
 * Inline image (photographed document). MIME allowlist on purpose: never
 * SVG (scripts) nor formats the sovereign vision models don't ingest.
 */
export const RouteImage = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  base64: z.string().min(1).max(14_000_000), // ≈ 10 MiB decoded, same cap as OCR
});
export type RouteImage = z.infer<typeof RouteImage>;

export const RouteTask = z.object({
  text: z.string().min(1).max(200_000),
  category: SensitivityCategory.optional(),
  tenantId: TenantId,
  requestId: z.string().min(1).max(200),
  hints: z.object({ public: z.boolean().optional(), ambiguous: z.boolean().optional() }).optional(),
  /** Photographed documents are confidential BY CONSTRUCTION (hardened below). */
  images: z
    .array(RouteImage)
    .max(4)
    .refine(
      (images) => images.reduce((sum, image) => sum + image.base64.length, 0) <= 14_000_000,
      { message: "images payload exceeds the aggregate cap" },
    )
    .optional(),
});
export type RouteTask = z.infer<typeof RouteTask>;

export interface RouteOptions {
  /** Prefer the frontier tier when (and only when) policy allows it. */
  preferFrontier?: boolean;
  /**
   * Force a specific model group (benchmarks, dedicated endpoints). STILL goes
   * through the hard guard — forcing can never break sovereignty.
   */
  forceGroup?: ModelGroup;
  /** Tool definitions exposed to the model (routeChat only). */
  tools?: ToolDefinition[];
}

/** Shared audit write (hash only, under the tenant's RLS context). */
async function audit(
  tenantId: string,
  requestId: string,
  category: SensitivityCategory,
  group: ModelGroup,
  decidedBy: "rules" | "llm",
  outcome: "allowed" | "blocked" | "failed",
  text: string,
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.classification.create({
      data: {
        tenantId,
        requestId,
        category,
        tier: group,
        decidedBy,
        outcome,
        contentHash: sha256(text),
      },
    }),
  );
}

export interface RouteResult {
  text: string;
  category: SensitivityCategory;
  group: ModelGroup;
  decidedBy: "rules" | "llm";
}

/** Categories allowed per tier, independent of any tenant policy (invariant). */
function sovereigntyAllows(category: SensitivityCategory, group: ModelGroup): boolean {
  if (group === "frontier") return category === "non_sensible";
  return true; // every other group is sovereign
}

/**
 * HARD GUARD — the last line of defense. Runs immediately before any network
 * emission, independently of the (possibly misconfigured) policy table.
 */
export function assertSovereignty(
  category: SensitivityCategory,
  group: ModelGroup,
  requestId: string,
): void {
  if (!sovereigntyAllows(category, group)) {
    // Incident log: names and ids only — never content.
    console.error("[SOVEREIGNTY-VIOLATION-BLOCKED]", { category, group, requestId });
    throw new SovereigntyViolationError(category, group, requestId);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Routes a payload to an allowed model tier via LiteLLM and audits the decision
 * (hash only, never the content) under the tenant's RLS context.
 */
/** Severity order — used to make caller-declared categories monotonic (harden only). */
const SEVERITY: Record<SensitivityCategory, number> = {
  non_sensible: 0,
  interne: 1,
  confidentiel: 2,
};

export async function route(task: RouteTask, opts: RouteOptions = {}): Promise<RouteResult> {
  const parsed = RouteTask.parse(task);
  const { text, tenantId, requestId, hints } = parsed;

  // 1) ALWAYS classify — a caller-declared category can only HARDEN the verdict,
  //    never soften it (audit finding 1.1: declaring `non_sensible` on an IBAN
  //    payload must not open the frontier tier).
  const detected = await classify(
    { text, ...(hints ? { hints } : {}) },
    {
      fallback: (t) =>
        chatCompletion("sovereign-fast", [
          { role: "system", content: CLASSIFICATION_PROMPT },
          { role: "user", content: t },
        ]),
    },
  );
  let category = detected.category;
  let decidedBy = detected.decidedBy;
  if (parsed.category && SEVERITY[parsed.category] > SEVERITY[detected.category]) {
    category = parsed.category;
    decidedBy = "rules";
  }
  // A photographed document is confidential BY CONSTRUCTION: the text-only
  // classifier cannot see what the image contains, so images can only harden.
  if (parsed.images?.length && SEVERITY[category] < SEVERITY.confidentiel) {
    category = "confidentiel";
    decidedBy = "rules";
  }

  // 2) Tenant routing policy — read UNDER withTenant (RLS context required).
  const policy = await withTenant(tenantId, (tx) =>
    tx.tenantPolicy.findUnique({ where: { tenantId } }),
  );
  const allowed = allowedTiers(category, { frontierEnabled: policy?.frontierEnabled ?? false });

  // 3) Pick a group (forced > frontier preference > sovereign default).
  const group: ModelGroup =
    opts.forceGroup ??
    (opts.preferFrontier && allowed.includes("frontier") ? "frontier" : "sovereign-fast");

  // Hash covers EVERYTHING sent to the model: the text and every image.
  const contentHash = createHash("sha256").update(text, "utf8");
  for (const image of parsed.images ?? []) contentHash.update(image.base64);
  const hash = contentHash.digest("hex");

  const audit = (outcome: "allowed" | "blocked" | "failed"): Promise<unknown> =>
    withTenant(tenantId, (tx) =>
      tx.classification.create({
        data: {
          tenantId,
          requestId,
          category,
          tier: group,
          decidedBy,
          outcome,
          contentHash: hash,
        },
      }),
    );

  // 4) HARD GUARD before any network call: static sovereignty invariant AND
  //    tenant policy. A config bug must never emit to a forbidden tier — and
  //    blocked attempts leave an audit trace too.
  try {
    assertSovereignty(category, group, requestId);
    if (!allowed.includes(group)) {
      console.error("[POLICY-VIOLATION-BLOCKED]", { category, group, requestId });
      throw new SovereigntyViolationError(category, group, requestId);
    }
  } catch (error) {
    await audit("blocked");
    throw error;
  }

  // 5) Model call through LiteLLM (OpenAI-compatible), never a provider SDK.
  //    Failures are audited as well (hash only, never content). Images travel
  //    as data-URI content parts (multimodal sovereign models, e.g. vision).
  const content: ChatMessage["content"] = parsed.images?.length
    ? [
        { type: "text", text },
        ...parsed.images.map((image) => ({
          type: "image_url" as const,
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
        })),
      ]
    : text;
  const messages: ChatMessage[] = [{ role: "user", content }];
  let responseText: string;
  try {
    responseText = await chatCompletion(group, messages);
  } catch (error) {
    await audit("failed");
    throw error;
  }

  // 6) Audit the successful decision under the tenant context.
  await audit("allowed");

  return { text: responseText, category, group, decidedBy };
}

/** Embeddings helper — always the sovereign `embeddings` group. */
export async function embed(texts: string[]): Promise<number[][]> {
  z.array(z.string().min(1)).min(1).parse(texts);
  return embeddings(texts);
}

// ── routeChat: the agent-loop sibling of route() (ADR-006) ──────────────────────

export type { AssistantTurn, LoopMessage, ToolDefinition } from "./litellm.js";

export const RouteChatTask = z.object({
  /** Full conversation, including prior assistant/tool turns. */
  messages: z.array(z.record(z.unknown())).min(1),
  category: SensitivityCategory.optional(),
  tenantId: TenantId,
  requestId: z.string().min(1).max(200),
});
export type RouteChatTask = {
  messages: LoopMessage[];
  category?: SensitivityCategory;
  tenantId: string;
  requestId: string;
};

/**
 * Everything that will be SENT to the model must be classified and hashed:
 * plain contents AND tool-call arguments (a drafted email or an IBAN can sit
 * in the arguments of an assistant tool call, not in any `content`).
 */
function conversationText(messages: LoopMessage[]): string {
  return messages
    .flatMap((message) => {
      const parts: string[] = [];
      if ("content" in message && typeof message.content === "string" && message.content) {
        parts.push(message.content);
      }
      // Multimodal content parts: text AND image data-URIs enter the
      // classified/hashed text — nothing sent to the model escapes the audit.
      if ("content" in message && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") parts.push(part.text);
          else if (part.type === "image_url") parts.push(part.image_url.url);
        }
      }
      if ("tool_calls" in message && message.tool_calls) {
        for (const call of message.tool_calls) parts.push(call.function.arguments);
      }
      return parts;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** True when any message carries an image part (multimodal conversation). */
function conversationHasImages(messages: LoopMessage[]): boolean {
  return messages.some(
    (message) =>
      "content" in message &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
}

/**
 * One agent-loop iteration through the sovereign gateway (ADR-006): classify
 * the WHOLE conversation (a later turn can carry more sensitive content than
 * the first), apply the tenant policy, HARD GUARD, call LiteLLM with tools,
 * audit (hash only). The loop in apps/agent-runtime calls this every iteration
 * — sovereignty is structural, not a configuration.
 */
export async function routeChat(
  task: RouteChatTask,
  opts: RouteOptions = {},
): Promise<{ turn: AssistantTurn; category: SensitivityCategory; group: ModelGroup }> {
  RouteChatTask.parse(task);
  const { messages, tenantId, requestId } = task;
  const text = conversationText(messages) || "(conversation vide)";

  // Always classify; a declared category can only harden (same rule as route()).
  const detected = await classify(
    { text },
    {
      fallback: (t) =>
        chatCompletion("sovereign-fast", [
          { role: "system", content: CLASSIFICATION_PROMPT },
          { role: "user", content: t },
        ]),
    },
  );
  const severity: Record<SensitivityCategory, number> = {
    non_sensible: 0,
    interne: 1,
    confidentiel: 2,
  };
  let category = detected.category;
  let decidedBy = detected.decidedBy;
  if (task.category && severity[task.category] > severity[category]) {
    category = task.category;
    decidedBy = "rules";
  }
  // Same invariant as route(): a photographed document is confidential BY
  // CONSTRUCTION — the text classifier cannot see inside an image, so a
  // multimodal conversation can never soften below `confidentiel`.
  if (conversationHasImages(messages) && severity[category] < severity.confidentiel) {
    category = "confidentiel";
    decidedBy = "rules";
  }

  const policy = await withTenant(tenantId, (tx) =>
    tx.tenantPolicy.findUnique({ where: { tenantId } }),
  );
  const allowed = allowedTiers(category, { frontierEnabled: policy?.frontierEnabled ?? false });
  const group: ModelGroup =
    opts.forceGroup ??
    (opts.preferFrontier && allowed.includes("frontier") ? "frontier" : "sovereign-fast");

  assertSovereignty(category, group, requestId);
  if (!allowed.includes(group)) {
    console.error("[POLICY-VIOLATION-BLOCKED]", { category, group, requestId });
    await audit(tenantId, requestId, category, group, decidedBy, "blocked", text);
    throw new SovereigntyViolationError(category, group, requestId);
  }

  try {
    const turn = await chatCompletionWithTools(group, messages, opts.tools ?? []);
    await audit(tenantId, requestId, category, group, decidedBy, "allowed", text);
    return { turn, category, group };
  } catch (error) {
    await audit(tenantId, requestId, category, group, decidedBy, "failed", text);
    throw error;
  }
}
export { transcribe, TranscribeTask, TRANSCRIPTION_MAX_BYTES } from "./transcribe.js";
export type { TranscribeResult } from "./transcribe.js";
export {
  AUDIO_FORMATS,
  AUDIO_FORMATS_VERSION,
  PROVIDER_CONFIRMED_FORMATS,
  sniffAudioFormat,
} from "./audioFormat.js";
export type { AudioFormat } from "./audioFormat.js";
