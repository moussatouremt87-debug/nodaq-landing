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

/** Excluded from revenue: not (yet) real sales. Shared with the monthly report
 * (2.11) so the same invoice never counts on one screen and not on the other. */
export const EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "cancelled",
  "canceled",
  "estimate",
]);

/**
 * STRICT amount parsing: a malformed amount must be discarded, never silently
 * truncated into a wrong revenue ("12abc" -> 12 € would feed the cockpit as
 * valid data). Decimal comma tolerated; no thousands separators.
 */
const AMOUNT_RE = /^-?\d+(?:[.,]\d{1,2})?$/;

export function euroToCents(amount: string | number): number | null {
  if (typeof amount === "number") {
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  }
  const trimmed = amount.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  return Math.round(Number.parseFloat(trimmed.replace(",", ".")) * 100);
}

/**
 * Statuts d'une facture ÉCHUE. Le libellé varie d'un facturier à l'autre
 * (`late` chez Pennylane, `overdue` ailleurs) : ne reconnaître que `late`
 * afficherait « 0 € d'impayés » comme un constat alors que c'est un défaut de
 * correspondance — une affirmation fausse, pas une absence de données.
 *
 * `pending` en est volontairement ABSENT : une facture non encore exigible
 * n'est pas un impayé, et la compter gonflerait l'encours échu.
 */
export const OVERDUE_STATUSES: ReadonlySet<string> = new Set(["late", "overdue", "unpaid"]);

/** Éligible à une relance : échu, plus les factures en attente de règlement. */
export const UNPAID_STATUSES: ReadonlySet<string> = new Set([...OVERDUE_STATUSES, "pending"]);

/**
 * Pourquoi une facture n'entre pas dans un chiffre d'affaires. Le motif est
 * RENDU au lieu d'être perdu : le rapport mensuel (2.11) en fait des compteurs
 * affichés, la prévision (3.1) se contente de sauter la ligne.
 */
export type InvoiceRejection =
  /** Montant, date ou ligne illisible. */
  | "illisible"
  /** Brouillon, devis, facture annulée — ce n'est pas une vente. */
  | "exclue"
  /** Avoir ou ligne à zéro : ne s'additionne pas à un CA. */
  | "non_positif"
  /** Devise étrangère : jamais convertie à un taux inventé. */
  | "devise";

export type NormalizedInvoice =
  | { ok: true; cents: number; month: string }
  | { ok: false; reason: InvoiceRejection };

/**
 * Normalisation PARTAGÉE d'une facture en (centimes, mois) — l'UNIQUE endroit
 * où le produit décide qu'une facture compte dans un chiffre d'affaires.
 *
 * Deux écrans qui liraient la même facture différemment (l'un tolérant « eur »,
 * l'autre non ; l'un sommant les avoirs, l'autre non) afficheraient deux CA
 * pour le même mois. Partager les deux constantes ne suffisait pas : c'est la
 * SÉQUENCE de décisions qui doit être unique.
 */
export function normalizeSaleInvoice(candidate: unknown): NormalizedInvoice {
  // safeParse par ligne : une ligne malformée est écartée, jamais une
  // exception dont la ZodError repartirait vers le modèle comme erreur d'outil.
  const item = ForecastInvoice.safeParse(candidate);
  if (!item.success) return { ok: false, reason: "illisible" };
  const invoice = item.data;
  if (invoice.status && EXCLUDED_STATUSES.has(invoice.status)) {
    return { ok: false, reason: "exclue" };
  }
  if (!invoice.date || invoice.amount == null) return { ok: false, reason: "illisible" };
  // Une devise étrangère ne se somme pas avec des euros (V1 : EUR only).
  if (invoice.currency && invoice.currency !== "EUR") return { ok: false, reason: "devise" };
  const cents = euroToCents(invoice.amount);
  if (cents === null) return { ok: false, reason: "illisible" };
  if (cents <= 0) return { ok: false, reason: "non_positif" };
  const date = new Date(invoice.date);
  if (Number.isNaN(date.getTime())) return { ok: false, reason: "illisible" };
  return { ok: true, cents, month: monthKey(date) };
}

/** Champ porté par l'interface facturier quand une part du montant N'EST PAS
 * exigible (retenue de garantie au 4117 — US-8). Absent chez Pennylane : la
 * valeur par défaut est 0, et rien ne change pour les autres facturiers. */
const RetainedShape = z.object({
  retained_amount: z.union([z.string(), z.number()]).nullish(),
});

/**
 * Retenue de garantie portée par une facture, en centimes (0 par défaut).
 *
 * Une valeur illisible ou négative vaut 0 : dans le doute on ne DÉDUIT rien —
 * déduire au hasard effacerait une créance réelle, ce qui est pire que la
 * relance abusive que la retenue fait éviter.
 */
export function retainedCentsOf(candidate: unknown): number {
  const parsed = RetainedShape.safeParse(candidate);
  if (!parsed.success || parsed.data.retained_amount == null) return 0;
  const cents = euroToCents(parsed.data.retained_amount);
  return cents !== null && cents > 0 ? cents : 0;
}

/**
 * Part EXIGIBLE d'une facture — l'UNIQUE endroit où le produit décide de ce
 * qu'il peut réclamer aujourd'hui.
 *
 * Le montant facturé reste le montant du marché (il fait le CA) ; la retenue
 * de garantie est due mais pas encore exigible : elle ne se relance pas et
 * n'entre pas dans l'encours échu. Deux écrans qui trancheraient séparément
 * finiraient par réclamer 10 000 € ici et 9 500 € là pour la même facture.
 */
export function claimableCents(candidate: unknown, totalCents: number): number {
  return Math.max(0, totalCents - retainedCentsOf(candidate));
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
    // Décision partagée avec le rapport mensuel (2.11) : ici le motif de rejet
    // ne sert à rien, la ligne est simplement sautée.
    const normalized = normalizeSaleInvoice(candidate);
    if (!normalized.ok) continue;
    const bucket = byMonth.get(normalized.month) ?? { revenueCents: 0, invoiceCount: 0 };
    bucket.revenueCents += normalized.cents;
    bucket.invoiceCount += 1;
    byMonth.set(normalized.month, bucket);
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
