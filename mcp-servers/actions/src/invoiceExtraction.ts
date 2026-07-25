import { z } from "zod";
import { route } from "@nodaq/llm";

/**
 * Structured field extraction from raw invoice text — through route() ONLY:
 * the text is `confidentiel` (declared, and re-detected by the always-on
 * classifier), so it can never leave the sovereign tier.
 */

export const InvoiceFields = z.object({
  supplierName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string().nullable(),
  totalExclTax: z.number().nullable(),
  totalTax: z.number().nullable(),
  totalInclTax: z.number().nullable(),
});
export type InvoiceFields = z.infer<typeof InvoiceFields>;

const EXTRACTION_PROMPT =
  "Tu extrais les champs d'une facture fournisseur française. Réponds UNIQUEMENT " +
  "avec un objet JSON (aucun autre texte) avec exactement ces clés : supplierName, " +
  "invoiceNumber, invoiceDate (YYYY-MM-DD), dueDate (YYYY-MM-DD), currency (ISO), " +
  "totalExclTax, totalTax, totalInclTax (nombres). Valeur null si absente du texte.\n\n" +
  "Texte de la facture :\n";

/** Strips optional markdown fences around a JSON answer. */
function stripFences(answer: string): string {
  return answer
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

export async function extractInvoiceFields(
  tenantId: string,
  requestId: string,
  invoiceText: string,
): Promise<InvoiceFields> {
  const result = await route({
    text: EXTRACTION_PROMPT + invoiceText,
    category: "confidentiel",
    tenantId,
    requestId,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(result.text));
  } catch {
    // Never echo model output (it may quote invoice content).
    throw new Error("invoice extraction returned non-JSON output");
  }
  return InvoiceFields.parse(parsed);
}
