import { buildDepreciationPlan, planEndYear, wearRatioAtYearEnd } from "./depreciation.js";
import type { DepreciationInput } from "./depreciation.js";
import { FRENCH_TAX_RULES_VERSION, IS_RATES } from "./frenchTax.js";

/*
 * Treasury impact of the asset registry (ticket 2.19). THE design rule:
 * a depreciation charge NEVER becomes a cash flow. The ONLY outputs of this
 * module that may enter a treasury projection are:
 * - the ESTIMATED corporate-tax saving produced by the year's dotations
 *   (labeled estimation, to be validated by the accountant), and
 * - the renewal CAPEX wall (optional scenario, user-toggled).
 * The guard is tested: no emitted flow ever equals a dotation.
 */

export interface RegistryAsset extends DepreciationInput {
  id: string;
  label: string;
  renewalCostCents: number | null;
  status: string;
}

export interface IsImpactEstimate {
  /** Dotations of the current fiscal year (calendar), in cents. */
  currentYearDepreciationCents: number;
  /** Estimated IS saving = dotations x marginal rate (simplified V1). */
  estimatedTaxSavingCents: number;
  /** Marginal rate applied (reduced 15 % under the cap, else 25 %). */
  marginalRate: number;
  /** Upcoming quarterly installment dates (ISO) within 12 months. */
  upcomingInstallments: string[];
  /** ALWAYS displayed: this is an estimate, the accountant validates. */
  label: "estimation — à valider avec votre expert-comptable";
  /** Version datée du jeu de règles fiscales qui a produit le chiffre. */
  rulesVersion: string;
}

/**
 * Simplified V1 estimate: the tax effect of dotations at the marginal rate.
 * We do NOT pretend to compute the company's actual IS (profit unknown) —
 * we quantify how much the dotations REDUCE it, dated on the installment
 * calendar. Assumption (documented): profit above the reduced-rate cap uses
 * the standard rate, else the reduced rate.
 */
export function estimateIsImpact(
  assets: RegistryAsset[],
  now: Date,
  options: { assumeProfitAboveCapEur?: boolean } = {},
): IsImpactEstimate {
  const year = now.getUTCFullYear();
  let dotations = 0;
  for (const asset of assets) {
    if (asset.status !== "ACTIF") continue;
    const line = buildDepreciationPlan(asset).lines.find((l) => l.year === year);
    dotations += line?.dotationCents ?? 0;
  }
  const marginalRate =
    (options.assumeProfitAboveCapEur ?? true) ? IS_RATES.standardRate : IS_RATES.reducedRate;
  const upcoming: string[] = [];
  for (let offset = 0; offset <= 1; offset++) {
    for (const { month, day } of IS_RATES.installmentDates) {
      const date = new Date(Date.UTC(year + offset, month - 1, day));
      if (date > now && upcoming.length < 4) {
        upcoming.push(date.toISOString().slice(0, 10));
      }
    }
  }
  return {
    currentYearDepreciationCents: dotations,
    estimatedTaxSavingCents: Math.round(dotations * marginalRate),
    marginalRate,
    upcomingInstallments: upcoming,
    label: "estimation — à valider avec votre expert-comptable",
    rulesVersion: FRENCH_TAX_RULES_VERSION,
  };
}

export interface RenewalQuarter {
  /** "YYYY-Qn" */
  quarter: string;
  capexCents: number;
  assets: { id: string; label: string }[];
}

/**
 * Renewal wall: each ACTIVE asset lands a forecast CAPEX (renewal cost or,
 * by default, its historical base) at the END of its depreciation plan,
 * bucketed by quarter over the horizon. Scenario data — the UI toggles it,
 * it is never forced into the projection.
 */
export function renewalWall(
  assets: RegistryAsset[],
  now: Date,
  horizonMonths = 24,
): RenewalQuarter[] {
  const horizon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + horizonMonths, 1));
  const buckets = new Map<string, RenewalQuarter>();
  for (const asset of assets) {
    if (asset.status !== "ACTIF") continue;
    const endYear = planEndYear(asset);
    if (endYear === null) continue;
    // End of plan ~ renewal date; place it at the end-year quarter of the
    // last dotation (approximation assumed: year granularity -> Q4, unless
    // the plan ends earlier in its first years — good enough for a wall).
    const endDate = new Date(Date.UTC(endYear, 11, 31));
    if (endDate < now || endDate > horizon) continue;
    const quarter = `${endYear}-Q4`;
    const bucket = buckets.get(quarter) ?? { quarter, capexCents: 0, assets: [] };
    bucket.capexCents += asset.renewalCostCents ?? asset.baseCents;
    bucket.assets.push({ id: asset.id, label: asset.label });
    buckets.set(quarter, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.quarter.localeCompare(b.quarter));
}

/** End-of-life alert threshold (>= 80 % amorti). */
export const END_OF_LIFE_WEAR = 0.8;

export function endOfLifeAssets(assets: RegistryAsset[], now: Date): RegistryAsset[] {
  const year = now.getUTCFullYear();
  return assets.filter(
    (asset) => asset.status === "ACTIF" && wearRatioAtYearEnd(asset, year) >= END_OF_LIFE_WEAR,
  );
}
