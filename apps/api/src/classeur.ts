import { z } from "zod";
import { route } from "@nodaq/llm";
import type { RouteImage } from "@nodaq/llm";

/*
 * Classeur documentaire photo (ticket 2.16) — extraction et rapprochement.
 *
 * Extraction : la photo du document part UNIQUEMENT par route() (catégorie
 * confidentiel par construction côté packages/llm dès qu'une image est
 * présente) vers le tier souverain vision. Le contenu du document n'apparaît
 * jamais dans les logs ni les erreurs.
 *
 * Rapprochement : fonctions PURES scorant les transactions bancaires
 * (client Qonto existant) contre les champs extraits — testables sans réseau.
 */

export const DOC_TYPES = ["facture_fournisseur", "recu", "note_de_frais", "autre"] as const;

/** Texte issu du MODÈLE (donc d'une photo, donc potentiellement hostile) :
 * tronqué, jamais refusé — une valeur trop longue ne doit pas faire perdre
 * toute l'extraction, mais elle ne doit pas non plus se propager telle quelle
 * dans la mémoire d'apprentissage (2.16b) ni dans les réponses d'API. */
const modelText = (max: number) =>
  z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : value.slice(0, max)));

export const DocExtraction = z.object({
  docType: z.enum(DOC_TYPES),
  supplierName: modelText(300),
  pieceNumber: modelText(120),
  docDate: z.string().nullable(), // YYYY-MM-DD
  currency: z.string().nullable(),
  totalExclTax: z.number().nullable(), // euros
  totalTax: z.number().nullable(),
  totalInclTax: z.number().nullable(),
});
export type DocExtraction = z.infer<typeof DocExtraction>;

const EXTRACTION_PROMPT =
  "Tu lis la photo d'un document comptable français (facture fournisseur, reçu " +
  "de caisse, note de frais...). Réponds UNIQUEMENT avec un objet JSON (aucun " +
  "autre texte) avec exactement ces clés : docType (une valeur parmi " +
  '"facture_fournisseur", "recu", "note_de_frais", "autre"), supplierName, ' +
  "pieceNumber, docDate (YYYY-MM-DD), currency (ISO), totalExclTax, totalTax, " +
  "totalInclTax (nombres en euros). Valeur null si illisible ou absente.";

/** Strips optional markdown fences around a JSON answer. */
function stripFences(answer: string): string {
  return answer
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

export async function extractDocumentFields(
  tenantId: string,
  requestId: string,
  image: RouteImage,
): Promise<DocExtraction> {
  const result = await route({
    text: EXTRACTION_PROMPT,
    category: "confidentiel",
    tenantId,
    requestId,
    images: [image],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(result.text));
  } catch {
    // Never echo model output (it may quote document content).
    throw new Error("document extraction returned non-JSON output");
  }
  return DocExtraction.parse(parsed);
}

// ── Rapprochement bancaire (pur) ────────────────────────────────────────────────

export interface BankTransactionLike {
  transaction_id?: string | null;
  id?: string | null;
  amount_cents?: number | null;
  side?: string | null;
  settled_at?: string | null;
  label?: string | null;
}

export interface MatchCandidate {
  transactionId: string;
  label: string | null;
  amountCents: number;
  settledAt: string | null;
  /** 2 = montant exact + date proche (±7 j), 1 = montant exact seul. */
  score: number;
}

export function euroToCents(euros: number): number {
  return Math.round(euros * 100);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Candidats de rapprochement : dépenses (side=debit) au montant EXACT, classées
 * par proximité de date avec le document. Top 5, score décroissant.
 */
export function matchTransactions(
  extraction: Pick<DocExtraction, "totalInclTax" | "docDate">,
  transactions: BankTransactionLike[],
): MatchCandidate[] {
  if (extraction.totalInclTax === null || extraction.totalInclTax <= 0) return [];
  const docCents = euroToCents(extraction.totalInclTax);
  const docTime = extraction.docDate ? Date.parse(extraction.docDate) : Number.NaN;

  const candidates: (MatchCandidate & { distance: number })[] = [];
  for (const tx of transactions) {
    const id = tx.transaction_id ?? tx.id;
    if (!id || tx.side !== "debit" || tx.amount_cents !== docCents) continue;
    const txTime = tx.settled_at ? Date.parse(tx.settled_at) : Number.NaN;
    const distance =
      Number.isNaN(docTime) || Number.isNaN(txTime)
        ? Number.POSITIVE_INFINITY
        : Math.abs(txTime - docTime) / DAY_MS;
    candidates.push({
      transactionId: id,
      label: tx.label ?? null,
      amountCents: tx.amount_cents,
      settledAt: tx.settled_at ?? null,
      score: distance <= 7 ? 2 : 1,
      distance,
    });
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .slice(0, 5)
    .map(({ distance: _distance, ...candidate }) => candidate);
}
