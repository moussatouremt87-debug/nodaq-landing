import type { FacturXInvoice } from "./invoice.js";
import type { VatCategory } from "./profiles.js";

/*
 * THE single VAT breakdown (audit fix, ticket 2.3).
 *
 * EN 16931 arithmetic rules (BR-CO-*) have ZERO tolerance: the invoice total
 * VAT must equal the sum of the per-category VAT amounts written in the
 * document. Computing it twice — once per line for the audit, once per
 * bucket for the XML — produced invoices that passed our own audit and
 * failed the standard (3 lines of 33.33 € at 20 %: 3 × 6.67 = 20.01 vs
 * 66.66 × 20 % = 20.00). So there is now exactly ONE computation, used by
 * the auditor AND the serializer.
 */

export interface VatBucket {
  category: VatCategory;
  ratePercent: number;
  /** Taxable base, cents. */
  basisCents: number;
  /** VAT for this bucket, rounded once from the bucket base. */
  vatCents: number;
}

export interface VatBreakdown {
  buckets: VatBucket[];
  /** Sum of the bucket bases — the only defensible "total HT". */
  netCents: number;
  /** Sum of the bucket VAT amounts — the only defensible "total VAT". */
  vatCents: number;
  grossCents: number;
}

/** Line net amount, rounded once (cents). */
export function lineNetCents(line: { quantity: number; unitPriceCents: number }): number {
  return Math.round(line.quantity * line.unitPriceCents);
}

/**
 * Groups lines by (rate, category) and rounds the VAT ONCE per bucket —
 * the order the standard prescribes.
 */
export function computeVatBreakdown(invoice: FacturXInvoice): VatBreakdown {
  const buckets = new Map<string, VatBucket>();
  for (const line of invoice.lines) {
    const key = `${line.vatRate}|${line.vatCategory}`;
    const bucket = buckets.get(key) ?? {
      category: line.vatCategory,
      ratePercent: line.vatRate,
      basisCents: 0,
      vatCents: 0,
    };
    bucket.basisCents += lineNetCents(line);
    buckets.set(key, bucket);
  }
  const list = [...buckets.values()].map((bucket) => ({
    ...bucket,
    vatCents: Math.round((bucket.basisCents * bucket.ratePercent) / 100),
  }));
  const netCents = list.reduce((sum, bucket) => sum + bucket.basisCents, 0);
  const vatCents = list.reduce((sum, bucket) => sum + bucket.vatCents, 0);
  return { buckets: list, netCents, vatCents, grossCents: netCents + vatCents };
}
