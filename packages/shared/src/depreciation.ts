import { decliningBalanceCoefficient } from "./frenchTax.js";

/*
 * Depreciation engine (ticket 2.19) — pure, deterministic, ZERO LLM.
 * Conventions (documented, hand-verified reference cases in tests):
 * - fiscal year = calendar year (V1 assumption);
 * - LINEAIRE: prorata temporis from the in-service DAY, 360-day convention
 *   (30-day months) — the standard French fiscal convention;
 * - DEGRESSIF: starts on the 1st day of the in-service MONTH (monthly
 *   prorata), rate = linear rate x CGI 39 A coefficient, and switches to
 *   linear (remaining book value / remaining years) as soon as that becomes
 *   more favorable — the annuity is then FROZEN at the switch value;
 * - disposal truncates the disposal year pro rata to the disposal date;
 * - integer cents everywhere, final line adjusted so the plan sums to base.
 * A depreciation charge NEVER represents a cash outflow — callers integrate
 * tax/renewal effects, never the dotations themselves (guard tested at the
 * treasury layer).
 */

export type DepreciationMethod = "LINEAIRE" | "DEGRESSIF";

export interface DepreciationInput {
  baseCents: number;
  /** In-service date, "YYYY-MM-DD" or Date. */
  inServiceDate: string | Date;
  durationMonths: number;
  method: DepreciationMethod;
  /** Disposal/exit date — truncates the plan. */
  disposedAt?: string | Date | null;
}

export interface DepreciationYearLine {
  year: number;
  dotationCents: number;
  cumulativeCents: number;
  /** Book value (VNC) at year end. */
  endBookValueCents: number;
}

export interface DepreciationPlan {
  lines: DepreciationYearLine[];
  totalCents: number;
}

function toDate(value: string | Date): Date {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  if (Number.isNaN(date.getTime())) throw new Error("invalid date");
  return date;
}

/** 360-day convention: elapsed days since Jan 1 (month = 30 days). */
function days360FromYearStart(date: Date): number {
  return 30 * date.getUTCMonth() + Math.min(date.getUTCDate(), 30) - 1;
}

export function buildDepreciationPlan(input: DepreciationInput): DepreciationPlan {
  if (input.baseCents <= 0 || input.durationMonths <= 0) return { lines: [], totalCents: 0 };
  const start = toDate(input.inServiceDate);
  const disposal = input.disposedAt ? toDate(input.disposedAt) : null;
  return input.method === "DEGRESSIF"
    ? decliningPlan(input.baseCents, start, input.durationMonths, disposal)
    : linearPlan(input.baseCents, start, input.durationMonths, disposal);
}

/**
 * Hard bound on plan length: max legal-ish duration is 50 years (600 months)
 * plus a partial first year — anything beyond means a degenerate input, and
 * the remainder is dumped on the last line so the plan still sums to base.
 * TERMINATION GUARD (audit 2.19): with a micro base and a long duration the
 * rounded annuity is 0 and a naive loop never advances — the API event loop
 * would freeze for ALL tenants. Every non-disposal iteration progresses by
 * at least 1 cent.
 */
const MAX_PLAN_LINES = 60;

function linearPlan(
  baseCents: number,
  start: Date,
  durationMonths: number,
  disposal: Date | null,
): DepreciationPlan {
  const annualRate = 12 / durationMonths;
  const fullAnnuity = baseCents * annualRate;
  const lines: DepreciationYearLine[] = [];
  let cumulative = 0;
  let year = start.getUTCFullYear();
  // First year: remaining 360-convention days from the in-service day.
  let fraction = (360 - days360FromYearStart(start)) / 360;
  while (cumulative < baseCents) {
    if (disposal && year > disposal.getUTCFullYear()) break;
    let dotation = Math.round(fullAnnuity * fraction);
    if (disposal && year === disposal.getUTCFullYear()) {
      // Disposal year: prorata up to the disposal date (360-day convention).
      const upTo = (days360FromYearStart(disposal) + 1) / 360;
      const fromStart = year === start.getUTCFullYear() ? days360FromYearStart(start) / 360 : 0;
      dotation = Math.round(fullAnnuity * Math.max(0, upTo - fromStart));
    } else if (dotation <= 0) {
      dotation = 1; // progression plancher : jamais de boucle sans avancer
    }
    if (lines.length >= MAX_PLAN_LINES - 1 && !disposal) {
      dotation = baseCents - cumulative; // borne dure : solde sur la dernière ligne
    }
    dotation = Math.min(dotation, baseCents - cumulative);
    cumulative += dotation;
    lines.push({ year, dotationCents: dotation, cumulativeCents: cumulative, endBookValueCents: baseCents - cumulative });
    if (disposal && year === disposal.getUTCFullYear()) break;
    year += 1;
    fraction = 1;
  }
  return { lines, totalCents: cumulative };
}

function decliningPlan(
  baseCents: number,
  start: Date,
  durationMonths: number,
  disposal: Date | null,
): DepreciationPlan {
  const durationYears = durationMonths / 12;
  const rate = (12 / durationMonths) * decliningBalanceCoefficient(durationYears);
  const lines: DepreciationYearLine[] = [];
  let cumulative = 0;
  let year = start.getUTCFullYear();
  // Starts on the 1st of the in-service month.
  let monthsThisYear = 12 - start.getUTCMonth();
  let remainingYears = durationYears;
  let frozenLinearAnnuity: number | null = null;
  while (cumulative < baseCents && remainingYears > 1e-9 && lines.length < MAX_PLAN_LINES) {
    if (disposal && year > disposal.getUTCFullYear()) break;
    const bookValue = baseCents - cumulative;
    let dotation: number;
    if (frozenLinearAnnuity !== null) {
      dotation = Math.round(frozenLinearAnnuity);
    } else {
      const declining = bookValue * rate * (monthsThisYear / 12);
      const linearIfSwitch = bookValue / remainingYears;
      if (monthsThisYear === 12 && linearIfSwitch > bookValue * rate) {
        // Switch year: freeze the linear annuity (remaining VNC / remaining years).
        frozenLinearAnnuity = linearIfSwitch;
        dotation = Math.round(linearIfSwitch);
      } else {
        dotation = Math.round(declining);
      }
    }
    if (disposal && year === disposal.getUTCFullYear()) {
      const months = disposal.getUTCMonth() + 1 - (year === start.getUTCFullYear() ? start.getUTCMonth() : 0);
      dotation = Math.round((dotation * Math.max(0, months)) / monthsThisYear);
    } else if (dotation <= 0) {
      dotation = 1; // même garde de progression que le linéaire
    }
    if (remainingYears - monthsThisYear / 12 <= 1e-9) {
      dotation = baseCents - cumulative; // dernier exercice du plan : solde exact
    }
    dotation = Math.min(dotation, baseCents - cumulative);
    cumulative += dotation;
    lines.push({ year, dotationCents: dotation, cumulativeCents: cumulative, endBookValueCents: baseCents - cumulative });
    if (disposal && year === disposal.getUTCFullYear()) break;
    remainingYears -= monthsThisYear / 12;
    year += 1;
    monthsThisYear = 12;
  }
  return { lines, totalCents: cumulative };
}

/** Book value (VNC) at year END; before the plan = base, after = residual. */
export function bookValueAtYearEnd(input: DepreciationInput, year: number): number {
  const plan = buildDepreciationPlan(input);
  let value = input.baseCents;
  for (const line of plan.lines) {
    if (line.year <= year) value = line.endBookValueCents;
  }
  return year < (plan.lines[0]?.year ?? year + 1) ? input.baseCents : value;
}

/** Wear ratio [0..1] at a given year end. */
export function wearRatioAtYearEnd(input: DepreciationInput, year: number): number {
  if (input.baseCents <= 0) return 0;
  return (input.baseCents - bookValueAtYearEnd(input, year)) / input.baseCents;
}

/** Last year of the plan — the renewal-wall date (CAPEX prévisionnel). */
export function planEndYear(input: DepreciationInput): number | null {
  const plan = buildDepreciationPlan(input);
  return plan.lines.at(-1)?.year ?? null;
}
