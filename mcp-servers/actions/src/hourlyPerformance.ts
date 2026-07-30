import type { MonthlyRevenuePoint } from "./salesForecast.js";
import type { AbsenceInput } from "./staffingPlan.js";
import {
  DEFAULT_HOURLY_RATE_CENTS,
  StaffInput,
  WEEKS_PER_MONTH,
  WORK_DAYS_PER_WEEK,
  absenceDaysInMonth,
} from "./staffingPlan.js";

/*
 * Hourly performance (ticket 3.6) — deterministic and explainable, the
 * BACKWARD-looking counterpart of staffingPlan (3.5): observed monthly
 * revenue (customer invoices, 3.1 series) divided by the team's ESTIMATED
 * worked hours (current contracts minus recorded absences, same rounding
 * conventions as 3.5), compared to a configurable target billed rate. Pure
 * functions: no network, no DB. V1 has NO time tracking — hours come from
 * contracts, so every report is permanently labeled as an estimate.
 */

export interface HourlyPerformanceMonth {
  /** "YYYY-MM" */
  month: string;
  /** Estimated from current contracts minus absences — NOT a time sheet. */
  workedHours: number;
  absenceHours: number;
  revenueCents: number;
  /** null when no worked hour could be estimated (empty team). */
  revenuePerHourCents: number | null;
  verdict: "au-dessus" | "conforme" | "en-dessous" | "inconnu";
  /** French, self-contained justification with the figures. */
  reason: string;
}

export interface HourlyPerformanceReport {
  months: HourlyPerformanceMonth[];
  activeStaff: number;
  targetRateCents: number;
  /** Weighted average: total revenue / total estimated hours (null if none). */
  averageRateCents: number | null;
  /** Least-squares slope of the realized rate, cents/hour per month (0 if <3 points). */
  trendCentsPerMonth: number;
  label: "estimation — heures dérivées des contrats actuels (pas d'un pointage), CA des factures";
}

/** Tolerance band around the target rate (fraction of the target). */
const RATE_TOLERANCE = 0.1;

/**
 * Realized hourly performance over the observed revenue series (past months,
 * current month excluded — 3.1 convention). Leading zero-revenue months are
 * dropped (before the business existed); a zero AFTER activity started is a
 * real signal and stays. An empty team yields "inconnu" — never a division
 * by zero, never a fabricated rate.
 */
export function analyzeHourlyPerformance(
  staff: StaffInput[],
  absences: AbsenceInput[],
  series: MonthlyRevenuePoint[],
  options: { targetRateCents?: number } = {},
): HourlyPerformanceReport {
  const targetRateCents = options.targetRateCents ?? DEFAULT_HOURLY_RATE_CENTS;
  const active = staff.filter((member) => StaffInput.safeParse(member).success && member.active);
  const weeklyTotal = active.reduce((sum, member) => sum + member.weeklyHours, 0);

  const firstActive = series.findIndex((point) => point.revenueCents > 0);
  const observed = firstActive === -1 ? [] : series.slice(firstActive);
  const tolerance = Math.round(targetRateCents * RATE_TOLERANCE);
  const targetEur = (targetRateCents / 100).toFixed(0);

  const months: HourlyPerformanceMonth[] = [];
  let totalRevenue = 0;
  let totalHours = 0;
  for (const point of observed) {
    const [yearRaw, monthRaw] = point.month.split("-").map(Number);
    if (!yearRaw || !monthRaw || monthRaw < 1 || monthRaw > 12) continue;
    const monthIndex = monthRaw - 1;

    let absenceHours = 0;
    for (const absence of absences) {
      const member = active.find((candidate) => candidate.id === absence.staffId);
      if (!member) continue;
      const days = absenceDaysInMonth(absence, yearRaw, monthIndex);
      absenceHours += days * (member.weeklyHours / WORK_DAYS_PER_WEEK);
    }
    absenceHours = Math.round(absenceHours);
    const workedHours = Math.max(0, Math.round(weeklyTotal * WEEKS_PER_MONTH) - absenceHours);
    const revenueEur = (point.revenueCents / 100).toFixed(0);

    if (workedHours <= 0) {
      months.push({
        month: point.month,
        workedHours: 0,
        absenceHours,
        revenueCents: point.revenueCents,
        revenuePerHourCents: null,
        verdict: "inconnu",
        reason: `CA réalisé ${revenueEur} € mais 0 h travaillée estimée (équipe vide ou entièrement absente)`,
      });
      continue;
    }

    const rate = Math.round(point.revenueCents / workedHours);
    const gap = rate - targetRateCents;
    const verdict: HourlyPerformanceMonth["verdict"] =
      gap > tolerance ? "au-dessus" : gap < -tolerance ? "en-dessous" : "conforme";
    const gapEur = (Math.abs(gap) / 100).toFixed(0);
    const verdictText =
      verdict === "au-dessus"
        ? `AU-DESSUS de l'objectif (+${gapEur} €/h)`
        : verdict === "en-dessous"
          ? `EN-DESSOUS de l'objectif (−${gapEur} €/h) — vérifier taux facturé ou temps non facturé`
          : "conforme à l'objectif (écart dans la tolérance de 10 %)";
    totalRevenue += point.revenueCents;
    totalHours += workedHours;
    months.push({
      month: point.month,
      workedHours,
      absenceHours,
      revenueCents: point.revenueCents,
      revenuePerHourCents: rate,
      verdict,
      reason:
        `CA réalisé ${revenueEur} € ÷ ${workedHours} h estimées (${active.length} actifs, ` +
        `${absenceHours} h d'absences) = ${(rate / 100).toFixed(0)} €/h vs objectif ${targetEur} €/h : ${verdictText}`,
    });
  }

  const rated = months.filter((month) => month.revenuePerHourCents !== null);
  let trend = 0;
  if (rated.length >= 3) {
    // Least squares on (index, rate): slope = cov(x,y) / var(x).
    const n = rated.length;
    const xMean = (n - 1) / 2;
    const yMean = rated.reduce((sum, month) => sum + (month.revenuePerHourCents ?? 0), 0) / n;
    let cov = 0;
    let varX = 0;
    rated.forEach((month, x) => {
      cov += (x - xMean) * ((month.revenuePerHourCents ?? 0) - yMean);
      varX += (x - xMean) ** 2;
    });
    trend = varX > 0 ? Math.round(cov / varX) : 0;
  }

  return {
    months,
    activeStaff: active.length,
    targetRateCents,
    averageRateCents: totalHours > 0 ? Math.round(totalRevenue / totalHours) : null,
    trendCentsPerMonth: trend,
    label: "estimation — heures dérivées des contrats actuels (pas d'un pointage), CA des factures",
  };
}
