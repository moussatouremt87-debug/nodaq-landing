import { z } from "zod";
import type { MonthlyRevenuePoint } from "./salesForecast.js";

/*
 * Staffing plan (ticket 3.5) — deterministic and explainable, same philosophy
 * as salesForecast/customerSignals: monthly CAPACITY (contract hours minus
 * absences) versus an ESTIMATED workload derived from the sales forecast
 * (3.1) through a tenant-configurable average billed hourly rate. Pure
 * functions: no network, no DB. Every verdict carries its figures and the
 * workload side is ALWAYS labeled as an estimate — an optimization solver
 * and HR connectors (Silae) come later (blueprint V2+).
 */

export const StaffInput = z.object({
  id: z.string(),
  /** PII — stays inside the tool output (owner-only), never in logs. */
  name: z.string(),
  weeklyHours: z.number().int().min(0).max(80),
  active: z.boolean(),
});
export type StaffInput = z.infer<typeof StaffInput>;

export const AbsenceInput = z.object({
  staffId: z.string(),
  /** "YYYY-MM-DD" inclusive bounds. */
  startDate: z.string(),
  endDate: z.string(),
  type: z.string().optional(),
});
export type AbsenceInput = z.infer<typeof AbsenceInput>;

export interface StaffingMonth {
  /** "YYYY-MM" */
  month: string;
  capacityHours: number;
  absenceHours: number;
  /** Estimated from forecast revenue / hourly rate — null without forecast. */
  estimatedWorkloadHours: number | null;
  gapHours: number | null;
  verdict: "sous-capacite" | "sur-capacite" | "equilibre" | "inconnu";
  /** French, self-contained justification with the figures. */
  reason: string;
}

export interface StaffingPlan {
  months: StaffingMonth[];
  activeStaff: number;
  hourlyRateCents: number;
  label: "estimation — charge dérivée de la prévision de ventes";
}

/** Default average billed hourly rate (configurable per call): 60 €/h. */
export const DEFAULT_HOURLY_RATE_CENTS = 6_000;
/** Weeks per month (365.25 / 7 / 12). */
const WEEKS_PER_MONTH = 4.348;
/** Working days per week used to convert absence days into hours. */
const WORK_DAYS_PER_WEEK = 5;
/** Tolerance band around equilibrium (fraction of capacity). */
const BALANCE_TOLERANCE = 0.1;

function monthKey(year: number, monthIndex: number): string {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Overlap in WORKING days (5/7 approximation) between an absence and a month. */
function absenceDaysInMonth(absence: AbsenceInput, year: number, monthIndex: number): number {
  const monthStart = Date.UTC(year, monthIndex, 1);
  const monthEnd = Date.UTC(year, monthIndex + 1, 0);
  const from = Date.parse(`${absence.startDate}T00:00:00Z`);
  const to = Date.parse(`${absence.endDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  const start = Math.max(from, monthStart);
  const end = Math.min(to, monthEnd);
  if (end < start) return 0;
  const calendarDays = Math.floor((end - start) / 86_400_000) + 1;
  return calendarDays * (WORK_DAYS_PER_WEEK / 7);
}

/**
 * Capacity vs estimated workload over the coming months. Forecast points come
 * from forecastSales (3.1); a month without a forecast point yields verdict
 * "inconnu" — never a fabricated workload.
 */
export function buildStaffingPlan(
  staff: StaffInput[],
  absences: AbsenceInput[],
  forecastPoints: { month: string; revenueCents: number }[],
  now: Date,
  options: { horizonMonths?: number; hourlyRateCents?: number } = {},
): StaffingPlan {
  const horizon = options.horizonMonths ?? 3;
  const hourlyRateCents = options.hourlyRateCents ?? DEFAULT_HOURLY_RATE_CENTS;
  const active = staff.filter((member) => StaffInput.safeParse(member).success && member.active);
  const weeklyTotal = active.reduce((sum, member) => sum + member.weeklyHours, 0);
  const forecastByMonth = new Map(forecastPoints.map((point) => [point.month, point.revenueCents]));

  const months: StaffingMonth[] = [];
  for (let offset = 1; offset <= horizon; offset++) {
    const year = now.getUTCFullYear();
    const monthIndex = now.getUTCMonth() + offset;
    const month = monthKey(year, monthIndex);

    let absenceHours = 0;
    for (const absence of absences) {
      const member = active.find((candidate) => candidate.id === absence.staffId);
      if (!member) continue;
      const days = absenceDaysInMonth(absence, year, monthIndex);
      absenceHours += days * (member.weeklyHours / WORK_DAYS_PER_WEEK);
    }
    absenceHours = Math.round(absenceHours);

    const grossCapacity = Math.round(weeklyTotal * WEEKS_PER_MONTH);
    const capacityHours = Math.max(0, grossCapacity - absenceHours);

    const revenue = forecastByMonth.get(month);
    if (revenue === undefined || hourlyRateCents <= 0) {
      months.push({
        month,
        capacityHours,
        absenceHours,
        estimatedWorkloadHours: null,
        gapHours: null,
        verdict: "inconnu",
        reason: `capacité ${capacityHours} h (dont ${absenceHours} h d'absences déduites) — pas de prévision de ventes pour ce mois`,
      });
      continue;
    }

    const workload = Math.round(revenue / hourlyRateCents);
    const gap = capacityHours - workload;
    const tolerance = Math.round(capacityHours * BALANCE_TOLERANCE);
    const verdict: StaffingMonth["verdict"] =
      gap < -tolerance ? "sous-capacite" : gap > tolerance ? "sur-capacite" : "equilibre";
    const verdictText =
      verdict === "sous-capacite"
        ? `SOUS-capacité de ${Math.abs(gap)} h — prévoir renfort, intérim ou lissage`
        : verdict === "sur-capacite"
          ? `SUR-capacité de ${gap} h — place pour de nouveaux chantiers`
          : "équilibre (écart dans la tolérance de 10 %)";
    months.push({
      month,
      capacityHours,
      absenceHours,
      estimatedWorkloadHours: workload,
      gapHours: gap,
      verdict,
      reason:
        `capacité ${capacityHours} h (${active.length} actifs, ${absenceHours} h d'absences) vs ` +
        `charge estimée ${workload} h (CA prévu ÷ ${(hourlyRateCents / 100).toFixed(0)} €/h) : ${verdictText}`,
    });
  }

  return {
    months,
    activeStaff: active.length,
    hourlyRateCents,
    label: "estimation — charge dérivée de la prévision de ventes",
  };
}

/** Re-export helper so callers can feed forecast series directly. */
export type { MonthlyRevenuePoint };
