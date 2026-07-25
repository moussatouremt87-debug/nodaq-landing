import { z } from "zod";
import { SensitivityCategory } from "@nodaq/shared";
import type { ModelGroup } from "@nodaq/shared";

/*
 * Classification gateway (blueprint §5.1) — deterministic rules first, optional
 * sovereign-LLM fallback, and the category -> allowed-tiers routing policy.
 * This package is PURE (no I/O): the LLM fallback is injected by the caller
 * (packages/llm), which keeps the dependency graph acyclic and the rules
 * testable offline.
 */

export const ClassifyInput = z.object({
  text: z.string().min(1).max(200_000),
  hints: z
    .object({
      /** Caller knows the content is meant to be public (marketing copy...). */
      public: z.boolean().optional(),
      /** Caller cannot tell — allow the sovereign LLM fallback to decide. */
      ambiguous: z.boolean().optional(),
    })
    .optional(),
});
export type ClassifyInput = z.infer<typeof ClassifyInput>;

export interface Classification {
  category: SensitivityCategory;
  decidedBy: "rules" | "llm";
  signals: string[];
}

/** Sovereign-LLM fallback: receives the text, returns the raw model answer. */
export type ClassifierFallback = (text: string) => Promise<string>;

export interface ClassifyContext {
  fallback?: ClassifierFallback;
}

// ── Deterministic rules (each one has a dedicated test) ─────────────────────────

// IBAN: compact form (FR7612345678901234567890123) or spaced groups (FR76 1234 ...).
// Case-insensitive on purpose: "fr76..." must be caught too (audit finding 1.1).
const IBAN_COMPACT = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i;
const IBAN_SPACED = /\b[A-Z]{2}\d{2}(?:\s[A-Z0-9]{4}){3,8}(?:\s[A-Z0-9]{1,4})?\b/i;

// NIR (numéro de sécurité sociale FR): sex(1|2) yy mm dept(2A/2B ok) commune order [key].
const NIR = /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2]|[2-9]\d)\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b/i;

const PAYROLL_KEYWORDS = [
  "bulletin de paie",
  "bulletin de salaire",
  "fiche de paie",
  "salaire net",
  "salaire brut",
  "cotisations sociales",
  "net imposable",
];

const CONTRACT_KEYWORDS = [
  "contrat de travail",
  "promesse d'embauche",
  "rupture conventionnelle",
  "période d'essai",
  "clause de non-concurrence",
];

const BANK_KEYWORDS = ["relevé d'identité bancaire", "rib "];

const PUBLIC_MARKERS = [
  "communiqué de presse",
  "article de blog",
  "post linkedin",
  "page publique",
  "site web public",
];

const EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
const FR_PHONE = /\b0[1-9](?:[ .-]?\d{2}){4}\b/;
const BIRTH_DATE = /date de naissance/i;

function confidentialSignals(text: string): string[] {
  const signals: string[] = [];
  const lower = text.toLowerCase();

  if (IBAN_COMPACT.test(text) || IBAN_SPACED.test(text)) signals.push("iban");
  if (NIR.test(text)) signals.push("nir");
  if (BANK_KEYWORDS.some((k) => lower.includes(k))) signals.push("rib");
  if (PAYROLL_KEYWORDS.some((k) => lower.includes(k))) signals.push("paie");
  if (CONTRACT_KEYWORDS.some((k) => lower.includes(k))) signals.push("contrat");

  // Dense nominative PII: several distinct identifier kinds in one payload.
  const piiKinds = [EMAIL.test(text), FR_PHONE.test(text), BIRTH_DATE.test(text)].filter(
    Boolean,
  ).length;
  if (piiKinds >= 2) signals.push("pii-dense");

  return signals;
}

/**
 * Classifies a payload. Deterministic rules first; the LLM fallback runs ONLY
 * when the caller flags the input as ambiguous AND no rule matched.
 * FAIL-SAFE: any fallback error/indecision yields the MOST restrictive category
 * (`confidentiel`) — never fail open.
 */
export async function classify(
  input: ClassifyInput,
  ctx: ClassifyContext = {},
): Promise<Classification> {
  const { text, hints } = ClassifyInput.parse(input);

  const signals = confidentialSignals(text);
  if (signals.length > 0) {
    return { category: "confidentiel", decidedBy: "rules", signals };
  }

  const lower = text.toLowerCase();
  const publicMarker = PUBLIC_MARKERS.find((m) => lower.includes(m));
  if (hints?.public || publicMarker) {
    return {
      category: "non_sensible",
      decidedBy: "rules",
      signals: [hints?.public ? "hint:public" : `marker:${publicMarker}`],
    };
  }

  if (hints?.ambiguous) {
    if (!ctx.fallback) {
      // Ambiguity with no way to resolve it: most restrictive category wins.
      return { category: "confidentiel", decidedBy: "rules", signals: ["ambiguous", "fail-safe"] };
    }
    try {
      const answer = (await ctx.fallback(text)).trim().toLowerCase();
      const parsed = SensitivityCategory.safeParse(answer);
      if (parsed.success) {
        return { category: parsed.data, decidedBy: "llm", signals: ["fallback"] };
      }
      return {
        category: "confidentiel",
        decidedBy: "llm",
        signals: ["fallback-unparseable", "fail-safe"],
      };
    } catch {
      return { category: "confidentiel", decidedBy: "llm", signals: ["fallback-error", "fail-safe"] };
    }
  }

  return { category: "interne", decidedBy: "rules", signals: ["default"] };
}

/** Prompt for the sovereign LLM fallback (kept here so it is testable/reviewable). */
export const CLASSIFICATION_PROMPT =
  "Tu es un classifieur de sensibilité de données pour PME françaises. " +
  "Réponds par UN SEUL mot parmi : confidentiel, interne, non_sensible. " +
  "confidentiel = données bancaires, paie, contrats, PII nominative. " +
  "interne = contenu métier non nominatif. non_sensible = contenu public/générique.";

// ── Routing policy: category -> allowed model tiers ─────────────────────────────

export const SOVEREIGN_GROUPS: readonly ModelGroup[] = [
  "confidential",
  "sovereign-strong",
  "sovereign-fast",
];

export interface TenantRoutingPolicy {
  frontierEnabled: boolean;
}

/**
 * Allowed model tiers for a category. `confidentiel` and `interne` NEVER include
 * `frontier`; `non_sensible` includes it only when the tenant opted in (default off).
 */
export function allowedTiers(
  category: SensitivityCategory,
  policy: TenantRoutingPolicy = { frontierEnabled: false },
): ModelGroup[] {
  switch (category) {
    case "confidentiel":
      return [...SOVEREIGN_GROUPS];
    case "interne":
      return ["sovereign-strong", "sovereign-fast"];
    case "non_sensible":
      return policy.frontierEnabled ? [...SOVEREIGN_GROUPS, "frontier"] : [...SOVEREIGN_GROUPS];
  }
}
