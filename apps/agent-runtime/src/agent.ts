import { randomUUID } from "node:crypto";
import { withTenant } from "@nodaq/db";
import { routeChat } from "@nodaq/llm";
import type { LoopMessage } from "@nodaq/llm";
import { TenantId } from "@nodaq/shared";
import { COMPTA_SYSTEM_PROMPT } from "./prompt.js";
import { buildToolset } from "./tools.js";
import type { ToolsetContext } from "./tools.js";
import { createTracerFromEnv } from "./tracing.js";
import type { AgentTracer } from "./tracing.js";

/*
 * The Compta/Direction virtual employee (ADR-006): a bounded, model-agnostic
 * tool loop where EVERY inference iteration goes through routeChat — classify,
 * tenant policy, hard sovereignty guard, audit. Bound to ONE tenant from the
 * SESSION (constructed after requireAuth -> resolveTenant -> requireMembership
 * in apps/api); the tenant is never an input of the agent or of a tool.
 */

const MAX_ITERATIONS = 6;
const EMPLOYEE = "compta";

/** Streamed events — tool events carry NAMES only, never payload content. */
export type AgentEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "tool_call"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "assistant"; content: string }
  | { type: "done"; iterations: number };

export interface RunOptions {
  conversationId?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunResult {
  conversationId: string;
  answer: string;
  iterations: number;
}

export class ComptaAgent {
  private readonly tenantId: string;
  private readonly tracer: AgentTracer;

  constructor(private readonly context: ToolsetContext & { tracer?: AgentTracer }) {
    this.tenantId = TenantId.parse(context.tenantId);
    this.tracer = context.tracer ?? createTracerFromEnv();
  }

  /** Runs one user turn, resuming the conversation when an id is provided. */
  async run(userMessage: string, options: RunOptions = {}): Promise<RunResult> {
    const emit = options.onEvent ?? (() => undefined);
    const tenantId = this.tenantId;

    // Trace accumulator — metadata only (names, counts, latency), never content.
    const startedAt = Date.now();
    const requestIds: string[] = [];
    const tracedTools: { name: string; ok: boolean }[] = [];
    let outcome: "ok" | "error" = "error";
    let tracedConversationId = options.conversationId ?? "";

    // Resume: prior transcript is loaded UNDER the tenant's RLS context.
    const conversationId = options.conversationId ?? null;
    let messages: LoopMessage[];
    if (conversationId) {
      // Scoped to THIS employee: another employee's conversation (different
      // system prompt/perimeter) must not be resumable in the Compta loop.
      const existing = await withTenant(tenantId, (tx) =>
        tx.agentConversation.findFirst({
          where: { id: conversationId as string, employee: EMPLOYEE },
        }),
      );
      if (!existing) throw new Error("conversation not found");
      messages = existing.messages as unknown as LoopMessage[];
    } else {
      messages = [{ role: "system", content: COMPTA_SYSTEM_PROMPT }];
    }
    messages.push({ role: "user", content: userMessage });

    const toolset = await buildToolset({ ...this.context, employee: EMPLOYEE });
    try {
      let answer = "";
      let iterations = 0;
      for (; iterations < MAX_ITERATIONS; iterations++) {
        const requestId = `agent-${EMPLOYEE}-${randomUUID()}`;
        requestIds.push(requestId);
        const { turn } = await routeChat(
          { messages, tenantId, requestId },
          { tools: toolset.definitions },
        );

        if (turn.toolCalls.length === 0) {
          answer = turn.content ?? "";
          messages.push({ role: "assistant", content: turn.content });
          emit({ type: "assistant", content: answer });
          break;
        }

        messages.push({
          role: "assistant",
          content: turn.content,
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        });

        for (const call of turn.toolCalls) {
          emit({ type: "tool_call", name: call.name });
          let resultText: string;
          let ok = true;
          try {
            let args: unknown = {};
            try {
              args = JSON.parse(call.argumentsJson);
            } catch {
              throw new Error("invalid tool arguments (not JSON)");
            }
            resultText = await toolset.execute(call.name, args);
          } catch (error) {
            ok = false;
            resultText = `Erreur outil: ${error instanceof Error ? error.message : "inconnue"}`;
          }
          emit({ type: "tool_result", name: call.name, ok });
          tracedTools.push({ name: call.name, ok });
          messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
        }
      }
      const usedIterations = Math.min(iterations + 1, MAX_ITERATIONS);

      // Budget exhausted mid-work: NEVER end silently — pending actions may
      // already sit in the validation queue, the user must be told.
      if (!answer) {
        answer =
          "Je n'ai pas pu conclure dans le budget d'itérations imparti. " +
          "Des actions préparées peuvent être en attente dans la file de validation.";
        messages.push({ role: "assistant", content: answer });
        emit({ type: "assistant", content: answer });
      }

      // Persist the transcript under the tenant's RLS context (create or update).
      let finalConversationId: string;
      if (conversationId) {
        await withTenant(tenantId, (tx) =>
          tx.agentConversation.update({
            where: { id: conversationId as string },
            data: { messages: messages as unknown as object[] },
          }),
        );
        finalConversationId = conversationId;
      } else {
        const created = await withTenant(tenantId, (tx) =>
          tx.agentConversation.create({
            data: {
              tenantId,
              employee: EMPLOYEE,
              messages: messages as unknown as object[],
            },
          }),
        );
        finalConversationId = created.id;
      }
      emit({ type: "conversation", conversationId: finalConversationId });
      emit({ type: "done", iterations: usedIterations });

      tracedConversationId = finalConversationId;
      outcome = "ok";
      return { conversationId: finalConversationId, answer, iterations: usedIterations };
    } finally {
      await toolset.close();
      // Metadata-only observability (§6): best-effort, never fails the run
      // (errors swallowed), delay bounded by the tracer's own 5s timeout.
      await this.tracer.record({
        tenantId,
        employee: EMPLOYEE,
        conversationId: tracedConversationId,
        requestIds,
        iterations: requestIds.length,
        toolCalls: tracedTools,
        durationMs: Date.now() - startedAt,
        outcome,
      });
    }
  }
}
