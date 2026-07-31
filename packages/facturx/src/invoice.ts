import { z } from "zod";
import { OPERATION_CATEGORIES, VAT_CATEGORIES } from "./profiles.js";

/*
 * Normalized invoice model (ticket 2.3). Amounts are in CENTS everywhere, as
 * in the rest of the repo — the decimal conversion happens once, at XML
 * serialization. Sources feeding this model: the Pennylane interface, the
 * FEC-derived registry, or manual entry.
 */


/**
 * Text safe for an XML 1.0 document. Control characters are NOT escapable in
 * XML: a NUL in a customer name would produce a document no parser can read.
 * Rejected at the typed boundary rather than mangled at serialization.
 */
// Détecter ces caractères EST l'objet du contrôle : ils ne sont pas
// échappables en XML 1.0, donc ils ne doivent jamais entrer dans le modèle.
// eslint-disable-next-line no-control-regex
const XML_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const safeText = (max: number, min = 0): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !XML_CONTROL_CHARS.test(value), {
      message: "control characters are not valid in XML",
    });

const Address = z.object({
  street: safeText(200).default(""),
  postalCode: safeText(20).default(""),
  city: safeText(100).default(""),
  countryCode: z.string().trim().length(2).default("FR"),
});

const Party = z.object({
  name: safeText(200, 1),
  /** 14 digits; the SIREN (first 9) is a mandatory mention of the reform. */
  siret: safeText(20).default(""),
  /** Intra-community VAT number, e.g. FR12812345678. */
  vatNumber: safeText(20).optional(),
  address: Address,
});

const Line = z.object({
  description: safeText(500, 1),
  quantity: z.number().finite(),
  unitPriceCents: z.number().int(),
  /** Percentage, e.g. 20 or 5.5 — checked against the French scale in audit. */
  vatRate: z.number().finite(),
  vatCategory: z.enum(VAT_CATEGORIES).default("S"),
  unit: safeText(20).optional(),
});

export const FacturXInvoice = z.object({
  number: safeText(50),
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
  /** Already-paid deposit, cents — BR-CO-16: due = gross − prepaid. */
  prepaidCents: z.number().int().optional(),
  /** Legal wording required whenever VAT is not charged. */
  vatExemptionReason: safeText(300).optional(),
  /** Delivery date (BT-72) — emitted only when the tenant provides it. */
  deliveryDate: z.string().trim().optional(),
  /** Buyer reference (BT-10) — required by Chorus Pro for public buyers. */
  buyerReference: safeText(50).optional(),
  /** Free-text note carried into the XML (payment terms, PO reference…). */
  note: safeText(1000).optional(),
  purchaseOrderRef: safeText(50).optional(),
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
