import { z } from "zod";

/*
 * Customer signals (ticket 3.4) — deterministic and explainable, same
 * philosophy as salesForecast.ts: per-customer cadence, recency and amount
 * trend computed from customer invoices, mapped to actionable segments
 * (churn risk, upsell opportunity, loyal, new, one-off). Pure functions: no
 * network, no DB — the caller feeds invoices from the Pennylane interface
 * (real connector, demo fixtures, or FEC-derived registry). Every verdict
 * carries a French `reason` with the figures that justify it — the model
 * never has to invent numbers.
 */

/** Invoice subset needed here — matches the Pennylane interface shape. */
export const SignalInvoice = z.object({
  amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
  date: z.string().nullish(),
  status: z.string().nullish(),
  customer: z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().nullish(),
    })
    .nullish(),
});
export type SignalInvoice = z.infer<typeof SignalInvoice>;

export type CustomerSegment = "a_risque" | "en_croissance" | "fidele" | "nouveau" | "ponctuel";

export interface CustomerSignal {
  customerId: string;
  customerName: string | null;
  segment: CustomerSegment;
  invoiceCount: number;
  totalCents: number;
  /** "YYYY-MM-DD" of the most recent invoice. */
  lastInvoiceDate: string;
  /** Whole days since the most recent invoice. */
  recencyDays: number;
  /** Average days between invoices (null under 2 invoices). */
  cadenceDays: number | null;
  /** French, self-contained justification with the figures behind the verdict. */
  reason: string;
}

export interface CustomerSignalsResult {
  customers: CustomerSignal[];
  /** Valid sales invoices considered (attributed or not). */
  analyzedInvoices: number;
  /** Valid sales invoices with no customer reference — the analysis is
   * partial when this is high; callers must surface it, never hide it. */
  unattributedInvoices: number;
}

/** Excluded from the analysis: not (yet) real sales. */
const EXCLUDED_STATUSES = new Set(["draft", "cancelled", "canceled", "estimate"]);

/** Relationship younger than this = "nouveau" whatever else the data says. */
const NEW_CUSTOMER_DAYS = 90;
/** Minimum invoices before cadence-based verdicts (risk, growth, loyalty). */
const MIN_REGULAR_INVOICES = 3;
/** Silence floor: below this many days nobody is "at risk", even on a fast cadence. */
const MIN_SILENCE_DAYS = 60;
/** Basket growth threshold between period halves (+20 %). */
const GROWTH_RATIO = 1.2;

const DAY_MS = 86_400_000;

/** Same STRICT amount parsing as salesForecast: malformed = discarded. */
const AMOUNT_RE = /^-?\d+(?:[.,]\d{1,2})?$/;

function euroToCents(amount: string | number): number | null {
  if (typeof amount === "number") {
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  }
  const trimmed = amount.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  return Math.round(Number.parseFloat(trimmed.replace(",", ".")) * 100);
}

interface CustomerBucket {
  id: string;
  name: string | null;
  /** [timeMs, cents], appended in input order then sorted by time. */
  points: [number, number][];
}

const SEGMENT_ORDER: Record<CustomerSegment, number> = {
  a_risque: 0,
  en_croissance: 1,
  fidele: 2,
  nouveau: 3,
  ponctuel: 4,
};

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Segments, in evaluation order (first match wins):
 * - « nouveau » : première facture il y a moins de 90 j — trop tôt pour juger ;
 * - « a_risque » : >= 3 factures ET silence > max(2 x cadence, 60 j) —
 *   un client régulier devenu silencieux ;
 * - « en_croissance » : >= 3 factures ET panier moyen de la seconde moitié
 *   de période >= 1,2 x la première — opportunité upsell ;
 * - « fidele » : >= 3 factures, régulier et récent ;
 * - « ponctuel » : 1-2 factures sans régularité établie.
 */
function classify(bucket: CustomerBucket, nowMs: number): CustomerSignal {
  const points = [...bucket.points].sort((a, b) => a[0] - b[0]);
  const n = points.length;
  const firstMs = points[0]![0];
  const lastMs = points[n - 1]![0];
  const totalCents = points.reduce((sum, [, cents]) => sum + cents, 0);
  const recencyDays = Math.max(0, Math.floor((nowMs - lastMs) / DAY_MS));
  const ageDays = Math.max(0, Math.floor((nowMs - firstMs) / DAY_MS));
  const cadenceDays = n >= 2 ? Math.round((lastMs - firstMs) / DAY_MS / (n - 1)) : null;

  const base = {
    customerId: bucket.id,
    customerName: bucket.name,
    invoiceCount: n,
    totalCents,
    lastInvoiceDate: new Date(lastMs).toISOString().slice(0, 10),
    recencyDays,
    cadenceDays,
  };

  if (ageDays <= NEW_CUSTOMER_DAYS) {
    return {
      ...base,
      segment: "nouveau",
      reason: `première facture il y a ${ageDays} j — relation trop récente pour juger la régularité`,
    };
  }

  if (n >= MIN_REGULAR_INVOICES && cadenceDays !== null) {
    const silenceThreshold = Math.max(2 * cadenceDays, MIN_SILENCE_DAYS);
    if (recencyDays > silenceThreshold) {
      return {
        ...base,
        segment: "a_risque",
        reason:
          `${n} factures à cadence ~${cadenceDays} j, mais silencieux depuis ` +
          `${recencyDays} j (seuil d'alerte : ${silenceThreshold} j)`,
      };
    }
    const half = Math.floor(n / 2);
    const firstMean = mean(points.slice(0, half).map(([, cents]) => cents));
    const secondMean = mean(points.slice(n - half).map(([, cents]) => cents));
    if (half >= 1 && firstMean > 0 && secondMean >= GROWTH_RATIO * firstMean) {
      const pct = Math.round((secondMean / firstMean - 1) * 100);
      return {
        ...base,
        segment: "en_croissance",
        reason:
          `panier moyen en hausse de ${pct} % entre le début et la fin de période ` +
          `(cadence ~${cadenceDays} j) — opportunité de montée en gamme`,
      };
    }
    return {
      ...base,
      segment: "fidele",
      reason: `${n} factures régulières (cadence ~${cadenceDays} j), dernière il y a ${recencyDays} j`,
    };
  }

  return {
    ...base,
    segment: "ponctuel",
    reason: `${n} facture${n > 1 ? "s" : ""} sur la période, sans régularité établie`,
  };
}

/**
 * Per-customer signals from a window of customer invoices. Invalid rows are
 * skipped silently (same per-item safeParse discipline as buildMonthlySeries);
 * valid sales without a customer reference are COUNTED, not dropped silently —
 * they bound what the analysis can claim.
 *
 * The window is enforced HERE, not only by the caller's crawl (data
 * minimization): invoices older than `monthsBack` never enter the analysis —
 * fetchInvoiceWindow bounds the walk but can legitimately return older rows,
 * and a customer whose whole history predates the window must not be
 * published (name + revenue) as "at risk" years later.
 */
export function analyzeCustomerSignals(
  invoices: SignalInvoice[],
  now: Date,
  monthsBack = 24,
): CustomerSignalsResult {
  // Same window start convention as fetchInvoiceWindow.
  const windowStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1);
  const buckets = new Map<string, CustomerBucket>();
  let analyzedInvoices = 0;
  let unattributedInvoices = 0;

  for (const candidate of invoices) {
    const item = SignalInvoice.safeParse(candidate);
    if (!item.success) continue;
    const inv = item.data;
    if (!inv.date || inv.amount == null) continue;
    if (inv.status && EXCLUDED_STATUSES.has(inv.status)) continue;
    if (inv.currency && inv.currency !== "EUR") continue;
    const cents = euroToCents(inv.amount);
    if (cents === null || cents <= 0) continue;
    const timeMs = Date.parse(inv.date);
    if (Number.isNaN(timeMs) || timeMs < windowStartMs) continue;

    analyzedInvoices += 1;
    if (!inv.customer?.id) {
      unattributedInvoices += 1;
      continue;
    }
    const bucket = buckets.get(inv.customer.id) ?? {
      id: inv.customer.id,
      name: inv.customer.name ?? null,
      points: [],
    };
    if (bucket.name === null && inv.customer.name) bucket.name = inv.customer.name;
    bucket.points.push([timeMs, cents]);
    buckets.set(inv.customer.id, bucket);
  }

  const nowMs = now.getTime();
  const customers = [...buckets.values()]
    .map((bucket) => classify(bucket, nowMs))
    .sort(
      (a, b) =>
        SEGMENT_ORDER[a.segment] - SEGMENT_ORDER[b.segment] || b.totalCents - a.totalCents,
    );

  return { customers, analyzedInvoices, unattributedInvoices };
}
