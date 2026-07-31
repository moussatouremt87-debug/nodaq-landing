import { z } from "zod";
import { OPERATION_CATEGORIES, VAT_CATEGORIES } from "./profiles.js";

/*
 * Normalized invoice model (ticket 2.3). Amounts are in CENTS everywhere, as
 * in the rest of the repo — the decimal conversion happens once, at XML
 * serialization. Sources feeding this model: the Pennylane interface, the
 * FEC-derived registry, or manual entry.
 */

const Address = z.object({
  street: z.string().trim().max(200).default(""),
  postalCode: z.string().trim().max(20).default(""),
  city: z.string().trim().max(100).default(""),
  countryCode: z.string().trim().length(2).default("FR"),
});

const Party = z.object({
  name: z.string().trim().min(1).max(200),
  /** 14 digits; the SIREN (first 9) is a mandatory mention of the reform. */
  siret: z.string().trim().max(20).default(""),
  /** Intra-community VAT number, e.g. FR12812345678. */
  vatNumber: z.string().trim().max(20).optional(),
  address: Address,
});

const Line = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().finite(),
  unitPriceCents: z.number().int(),
  /** Percentage, e.g. 20 or 5.5 — checked against the French scale in audit. */
  vatRate: z.number().finite(),
  vatCategory: z.enum(VAT_CATEGORIES).default("S"),
  unit: z.string().trim().max(20).optional(),
});

export const FacturXInvoice = z.object({
  number: z.string().trim().max(50),
  /** ISO day, YYYY-MM-DD. */
  issueDate: z.string().trim(),
  dueDate: z.string().trim().optional(),
  currency: z.string().trim().length(3).default("EUR"),
  operationCategory: z.enum(
    Object.keys(OPERATION_CATEGORIES) as [keyof typeof OPERATION_CATEGORIES],
  ),
  seller: Party,
  buyer: Party,
  lines: z.array(Line).max(1000),
  totals: z.object({
    netCents: z.number().int(),
    vatCents: z.number().int(),
    grossCents: z.number().int(),
    dueCents: z.number().int(),
  }),
  /** Legal wording required whenever VAT is not charged. */
  vatExemptionReason: z.string().trim().max(300).optional(),
  /** Free-text note carried into the XML (payment terms, PO reference…). */
  note: z.string().trim().max(1000).optional(),
  purchaseOrderRef: z.string().trim().max(50).optional(),
});

export type FacturXInvoice = z.infer<typeof FacturXInvoice>;
export type FacturXLine = z.infer<typeof Line>;
export type FacturXParty = z.infer<typeof Party>;

/** Cents -> normative decimal string ("1290.00"). */
export function amount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** SIREN = first 9 digits of the SIRET (mandatory mention of the reform). */
export function sirenOf(siret: string): string {
  return siret.replace(/\D/g, "").slice(0, 9);
}
