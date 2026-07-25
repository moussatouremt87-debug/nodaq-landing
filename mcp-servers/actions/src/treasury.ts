import { z } from "zod";

/*
 * Treasury forecast (blueprint MVP: 30/60/90 days). Deterministic and simple
 * by design: current balance projected with the average daily net flow
 * observed over the transaction window. Nixtla-grade models come with the ML
 * service later — this is the explainable baseline the cockpit starts with.
 */

export const TreasuryTransaction = z.object({
  amountCents: z.number().int(),
  /** 'credit' | 'debit' — sign is applied from this, amounts come in positive. */
  side: z.enum(["credit", "debit"]),
  settledAt: z.string().datetime({ offset: true }),
});
export type TreasuryTransaction = z.infer<typeof TreasuryTransaction>;

export interface TreasuryForecastPoint {
  horizonDays: number;
  projectedBalanceCents: number;
}

export interface TreasuryForecast {
  currentBalanceCents: number;
  observedDays: number;
  avgDailyNetFlowCents: number;
  points: TreasuryForecastPoint[];
}

export function forecastTreasury(
  currentBalanceCents: number,
  transactions: TreasuryTransaction[],
  now: Date,
  horizons: number[] = [30, 60, 90],
): TreasuryForecast {
  const parsed = z.array(TreasuryTransaction).parse(transactions);

  // Floor on the observation window: a 1-2 day burst must not be extrapolated
  // to 90 days (RGPD audit 1.5 remark).
  const MIN_OBSERVED_DAYS = 14;
  let observedDays = 0;
  let netFlowCents = 0;
  if (parsed.length > 0) {
    const dates = parsed.map((t) => new Date(t.settledAt).getTime());
    const oldest = Math.min(...dates);
    observedDays = Math.max(MIN_OBSERVED_DAYS, Math.ceil((now.getTime() - oldest) / 86_400_000));
    netFlowCents = parsed.reduce(
      (sum, t) => sum + (t.side === "credit" ? Math.abs(t.amountCents) : -Math.abs(t.amountCents)),
      0,
    );
  }

  const avgDailyNetFlowCents = observedDays > 0 ? Math.round(netFlowCents / observedDays) : 0;

  return {
    currentBalanceCents,
    observedDays,
    avgDailyNetFlowCents,
    points: horizons.map((horizonDays) => ({
      horizonDays,
      projectedBalanceCents: currentBalanceCents + avgDailyNetFlowCents * horizonDays,
    })),
  };
}
