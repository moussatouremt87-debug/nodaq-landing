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

function euroToCents(amount: string | number): number | null {
  const value = typeof amount === "number" ? amount : Number.parseFloat(amount.replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
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
  const parsed = z.array(ForecastInvoice).parse(invoices);
  const byMonth = new Map<string, { revenueCents: number; invoiceCount: number }>();
  for (const invoice of parsed) {
    if (!invoice.date || invoice.amount == null) continue;
    if (invoice.status && EXCLUDED_STATUSES.has(invoice.status)) continue;
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
