/*
 * E-reporting aggregation (ticket 2.4) — the SECOND half of the reform.
 *
 * E-invoicing transmits the invoice itself (B2B domestic). E-reporting
 * transmits AGGREGATED transaction data for everything else: B2C sales,
 * foreign customers, out-of-scope operations. The administration receives
 * totals, never the nominative detail — that asymmetry is the whole point,
 * and this module is where we keep it honest.
 *
 * The function below is PURE: totals in, totals out, no I/O. It aggregates
 * the invoice ledger (Pennylane / démo / FEC — same source as 3.1 and 3.4)
 * over a period and reports what it could NOT use, item by item, instead of
 * quietly shrinking the total.
 *
 * What it deliberately does NOT do:
 *  - split B2B from B2C: the ledger carries no customer SIREN, so the split
 *    is not derivable. Guessing it would misfile a declaration;
 *  - derive VAT: the ledger amount is a single figure whose HT/TTC nature is
 *    not guaranteed across sources. `vatDerivable` is false and the owner
 *    supplies the VAT figure before anything is transmitted;
 *  - convert currencies: a non-EUR invoice is excluded and COUNTED.
 */

/** Ledger row, already normalized to cents by the caller. */
export interface EReportingSourceInvoice {
  amountCents: number | null;
  date: string | null;
  currency: string | null;
}

export interface EReportingAggregate {
  periodStart: string;
  periodEnd: string;
  /** Invoices counted in `totalCents`. */
  transactionCount: number;
  totalCents: number;
  currency: "EUR";
  /** Outside the period — normal, shown so the owner can widen the window. */
  outOfPeriodCount: number;
  /** Unusable rows (no date, no amount, non-finite) — never silently dropped. */
  unusableCount: number;
  /** Non-EUR rows: excluded, NEVER converted at an invented rate. */
  otherCurrencyCount: number;
  /** VAT is not derivable from the ledger — the owner declares it. */
  vatDerivable: false;
  caveats: string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a `YYYY-MM-DD` day into an UTC timestamp, or null. */
function dayValue(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const day = raw.slice(0, 10);
  if (!DATE_ONLY.test(day)) return null;
  const value = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(value) ? null : value;
}

/**
 * Aggregates the ledger over `[periodStart, periodEnd]` (inclusive days).
 * Throws on an invalid period: an aggregate over a nonsensical window would
 * be transmitted to the administration as if it meant something.
 */
export function aggregateEReporting(
  invoices: readonly EReportingSourceInvoice[],
  periodStart: string,
  periodEnd: string,
): EReportingAggregate {
  const from = dayValue(periodStart);
  const to = dayValue(periodEnd);
  if (from === null || to === null) throw new Error("invalid e-reporting period");
  if (to < from) throw new Error("invalid e-reporting period");

  let transactionCount = 0;
  let totalCents = 0;
  let outOfPeriodCount = 0;
  let unusableCount = 0;
  let otherCurrencyCount = 0;

  for (const invoice of invoices) {
    const day = dayValue(invoice.date);
    const cents = invoice.amountCents;
    if (day === null || cents === null || !Number.isFinite(cents)) {
      unusableCount += 1;
      continue;
    }
    if (day < from || day > to) {
      outOfPeriodCount += 1;
      continue;
    }
    // Absent currency = EUR (the ledger of a French SME); anything else is
    // excluded rather than converted.
    const currency = (invoice.currency ?? "EUR").toUpperCase();
    if (currency !== "EUR") {
      otherCurrencyCount += 1;
      continue;
    }
    transactionCount += 1;
    totalCents += Math.round(cents);
  }

  const caveats = [
    "Périmètre à confirmer : le facturier ne porte pas le SIREN du client, la répartition B2B / B2C n'est pas dérivable.",
    "TVA non dérivable du facturier : le montant de TVA doit être saisi par vos soins (ou par votre expert-comptable).",
  ];
  if (otherCurrencyCount > 0) {
    caveats.push(
      `${otherCurrencyCount} facture(s) dans une autre devise : exclues du total, jamais converties.`,
    );
  }
  if (unusableCount > 0) {
    caveats.push(`${unusableCount} ligne(s) sans date ou sans montant exploitable : exclues.`);
  }

  return {
    periodStart: periodStart.slice(0, 10),
    periodEnd: periodEnd.slice(0, 10),
    transactionCount,
    totalCents,
    currency: "EUR",
    outOfPeriodCount,
    unusableCount,
    otherCurrencyCount,
    vatDerivable: false,
    caveats,
  };
}
