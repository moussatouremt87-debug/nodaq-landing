import { z } from "zod";

/*
 * Sales forecast (ticket 3.1) — deterministic and explainable, same philosophy
 * as treasury.ts: monthly revenue observed on customer invoices, projected by
 * least-squares linear regression (or plain average on short histories).
 * Nixtla-grade models come with the ML service later — this is the baseline
 * the cockpit and the Compta employee start with. Pure functions: no network,
 * no DB — the caller feeds invoices from the Pennylane interface (real
 * connector, demo fixtures, or FEC-derived registry).
 */

/** Invoice subset needed here — matches the Pennylane interface shape. */
export const ForecastInvoice = z.object({
  amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
  date: z.string().nullish(),
  status: z.string().nullish(),
});
export type ForecastInvoice = z.infer<typeof ForecastInvoice>;

export interface MonthlyRevenuePoint {
  /** "YYYY-MM" */
  month: string;
  revenueCents: number;
  invoiceCount: number;
}

export interface SalesForecast {
  series: MonthlyRevenuePoint[];
  points: { month: string; revenueCents: number }[];
  observedMonths: number;
  /** Signed monthly trend on the observed window, in cents/month. */
  trendCentsPerMonth: number;
  method: "regression-lineaire" | "moyenne" | "aucune-donnee";
}

/** Excluded from revenue: not (yet) real sales. */
const EXCLUDED_STATUSES = new Set(["draft", "cancelled", "canceled", "estimate"]);

/**
 * STRICT amount parsing: a malformed amount must be discarded, never silently
 * truncated into a wrong revenue ("12abc" -> 12 € would feed the cockpit as
 * valid data). Decimal comma tolerated; no thousands separators.
 */
const AMOUNT_RE = /^-?\d+(?:[.,]\d{1,2})?$/;

function euroToCents(amount: string | number): number | null {
  if (typeof amount === "number") {
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  }
  const trimmed = amount.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  return Math.round(Number.parseFloat(trimmed.replace(",", ".")) * 100);
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(year: number, monthIndex: number, delta: number): string {
  const d = new Date(Date.UTC(year, monthIndex + delta, 1));
  return monthKey(d);
}

/**
 * Monthly revenue series over the trailing window (months with no invoice are
 * present with 0 — a hole IS a signal for the trend). Current month excluded:
 * it is incomplete and would always read as a crash.
 */
export function buildMonthlySeries(
  invoices: ForecastInvoice[],
  now: Date,
  monthsBack = 12,
): MonthlyRevenuePoint[] {
  const byMonth = new Map<string, { revenueCents: number; invoiceCount: number }>();
  for (const candidate of invoices) {
    // Per-item safeParse: one malformed row is skipped, never an exception
    // whose ZodError would travel back to the model as a tool error.
    const item = ForecastInvoice.safeParse(candidate);
    if (!item.success) continue;
    const invoice = item.data;
    if (!invoice.date || invoice.amount == null) continue;
    if (invoice.status && EXCLUDED_STATUSES.has(invoice.status)) continue;
    // Une devise étrangère ne se somme pas avec des euros (V1 : EUR only).
    if (invoice.currency && invoice.currency !== "EUR") continue;
    const cents = euroToCents(invoice.amount);
    if (cents === null || cents <= 0) continue;
    const date = new Date(invoice.date);
    if (Number.isNaN(date.getTime())) continue;
    const key = monthKey(date);
    const bucket = byMonth.get(key) ?? { revenueCents: 0, invoiceCount: 0 };
    bucket.revenueCents += cents;
    bucket.invoiceCount += 1;
    byMonth.set(key, bucket);
  }

  const series: MonthlyRevenuePoint[] = [];
  for (let i = monthsBack; i >= 1; i--) {
    const month = shiftMonth(now.getUTCFullYear(), now.getUTCMonth(), -i);
    const bucket = byMonth.get(month);
    series.push({
      month,
      revenueCents: bucket?.revenueCents ?? 0,
      invoiceCount: bucket?.invoiceCount ?? 0,
    });
  }
  return series;
}

/** Minimal client contract — satisfied by the Pennylane interface. */
export interface InvoiceLister {
  listCustomerInvoices(options: {
    limit?: number;
    cursor?: string;
  }): Promise<{ items: ForecastInvoice[]; next_cursor?: string | null | undefined }>;
}

export interface InvoiceWindow {
  invoices: ForecastInvoice[];
  /** True when the page cap stopped the walk with pages left: the series may
   * be missing OLD months — callers must surface it, never read a truncated
   * window as "these months had no sales". */
  truncated: boolean;
}

/**
 * Collects invoices for the trailing window. The provider's sort order is not
 * contractual, so the walk stops EITHER at the page cap OR as soon as a full
 * page is entirely older than the window start (whichever comes first), under
 * a global deadline — never an unbounded crawl of the tenant's history.
 */
export async function fetchInvoiceWindow(
  client: InvoiceLister,
  now: Date,
  { monthsBack = 12, maxPages = 5, deadlineMs = 20_000 }: {
    monthsBack?: number;
    maxPages?: number;
    deadlineMs?: number;
  } = {},
): Promise<InvoiceWindow> {
  const windowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1);
  const deadline = Date.now() + deadlineMs;
  const invoices: ForecastInvoice[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const { items, next_cursor } = await client.listCustomerInvoices({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    invoices.push(...items);
    if (!next_cursor) return { invoices, truncated: false };
    cursor = next_cursor;
    // Whole page older than the window: everything further back is unneeded
    // whatever the sort order claims for the pages we already have.
    const allOld =
      items.length > 0 &&
      items.every((invoice) => {
        const time = invoice.date ? Date.parse(invoice.date) : Number.NaN;
        return !Number.isNaN(time) && time < windowStart;
      });
    if (allOld) return { invoices, truncated: false };
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    if (pageIndex === maxPages - 1) truncated = true;
  }
  return { invoices, truncated };
}

/**
 * Forecast over `horizonMonths`, from the FIRST month with revenue onwards
 * (leading empty months = before the business existed, not a crash):
 * - >= 3 observed months: least-squares linear regression, clamped at 0 ;
 * - 1-2 observed months: plain average (a trend on 2 points is noise) ;
 * - nothing: zeros, flagged "aucune-donnee".
 */
export function forecastSales(series: MonthlyRevenuePoint[], horizonMonths = 3): SalesForecast {
  const firstActive = series.findIndex((point) => point.revenueCents > 0);
  const observed = firstActive === -1 ? [] : series.slice(firstActive);
  const n = observed.length;

  const last = series[series.length - 1];
  const [lastYear, lastMonth] = last
    ? last.month.split("-").map(Number)
    : [new Date().getUTCFullYear(), new Date().getUTCMonth() + 1];
  const futureMonth = (i: number): string => shiftMonth(lastYear ?? 0, (lastMonth ?? 1) - 1, i);

  if (n === 0) {
    return {
      series,
      points: Array.from({ length: horizonMonths }, (_, i) => ({
        month: futureMonth(i + 1),
        revenueCents: 0,
      })),
      observedMonths: 0,
      trendCentsPerMonth: 0,
      method: "aucune-donnee",
    };
  }

  const mean = observed.reduce((sum, p) => sum + p.revenueCents, 0) / n;
  let slope = 0;
  let method: SalesForecast["method"] = "moyenne";
  if (n >= 3) {
    // Least squares on (index, revenue): slope = cov(x,y) / var(x).
    const xMean = (n - 1) / 2;
    let cov = 0;
    let varX = 0;
    observed.forEach((point, x) => {
      cov += (x - xMean) * (point.revenueCents - mean);
      varX += (x - xMean) ** 2;
    });
    slope = varX > 0 ? cov / varX : 0;
    method = "regression-lineaire";
  }

  const intercept = mean - slope * ((n - 1) / 2);
  return {
    series,
    points: Array.from({ length: horizonMonths }, (_, i) => ({
      month: futureMonth(i + 1),
      revenueCents: Math.max(0, Math.round(intercept + slope * (n + i))),
    })),
    observedMonths: n,
    trendCentsPerMonth: Math.round(slope),
    method,
  };
}
