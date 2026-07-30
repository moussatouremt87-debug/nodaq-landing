import { z } from "zod";

/*
 * Reputation analysis (ticket 3.8) — deterministic and explainable, same
 * philosophy as customerSignals (3.4): aggregates over the tenant's recorded
 * customer reviews (imported or hand-entered — live platform feeds are a
 * future connector). Pure functions: no network, no DB, no LLM. Author names
 * (PII) NEVER enter this model — callers feed ratings, dates and reply
 * status only; alerts carry review ids, the UI resolves them.
 */

export const ReviewInput = z.object({
  id: z.string(),
  rating: z.number().int().min(1).max(5),
  /** ISO date (or datetime) of the review on the platform. */
  reviewedAt: z.string(),
  replyText: z.string().nullable(),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export interface ReputationTrend {
  /** Average rating over the last 6 months (reviews present). */
  recentAverage: number;
  /** Average over the 6 months before that. */
  previousAverage: number;
  verdict: "en_hausse" | "en_baisse" | "stable";
}

export interface NegativeAlert {
  id: string;
  rating: number;
  daysAgo: number;
}

export interface ReputationReport {
  totalReviews: number;
  /** null when no valid review — never a fabricated average. */
  averageRating: number | null;
  /** Count per rating "1".."5". */
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  /** Share of reviews with a recorded reply, in percent (rounded). */
  replyRatePct: number | null;
  /** 6-month vs previous-6-month averages — null without enough history. */
  trend: ReputationTrend | null;
  /** Recent (≤30 days) ratings ≤2 with no reply — ids only, no PII. */
  unansweredNegative: NegativeAlert[];
  label: "analyse des avis enregistrés dans NODAQ — pas un flux temps réel des plateformes";
}

const RECENT_ALERT_DAYS = 30;
const TREND_WINDOW_MONTHS = 6;
const TREND_VERDICT_EPSILON = 0.3;
const DAY_MS = 86_400_000;

function parseWhen(value: string): number | null {
  const time = Date.parse(value.includes("T") ? value : `${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * Aggregates over recorded reviews. Malformed rows are skipped (never an
 * exception), empty input yields an honest empty report.
 */
export function analyzeReputation(reviews: ReviewInput[], now: Date): ReputationReport {
  const valid: { id: string; rating: number; time: number; replied: boolean }[] = [];
  for (const candidate of reviews) {
    const parsed = ReviewInput.safeParse(candidate);
    if (!parsed.success) continue;
    const time = parseWhen(parsed.data.reviewedAt);
    if (time === null) continue;
    valid.push({
      id: parsed.data.id,
      rating: parsed.data.rating,
      time,
      replied: parsed.data.replyText !== null && parsed.data.replyText.trim() !== "",
    });
  }

  const distribution: ReputationReport["distribution"] = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const review of valid) {
    distribution[String(review.rating) as keyof typeof distribution] += 1;
  }

  const total = valid.length;
  const averageRating =
    total > 0
      ? Math.round((valid.reduce((sum, r) => sum + r.rating, 0) / total) * 100) / 100
      : null;
  const replyRatePct =
    total > 0 ? Math.round((valid.filter((r) => r.replied).length / total) * 100) : null;

  // Trend: recent 6 months vs the 6 months before — only when BOTH windows
  // have at least one review (never a trend on one side of silence).
  const recentStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - TREND_WINDOW_MONTHS, 1);
  const previousStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - 2 * TREND_WINDOW_MONTHS,
    1,
  );
  const recent = valid.filter((r) => r.time >= recentStart && r.time <= now.getTime());
  const previous = valid.filter((r) => r.time >= previousStart && r.time < recentStart);
  let trend: ReputationTrend | null = null;
  if (recent.length > 0 && previous.length > 0) {
    const recentAverage =
      Math.round((recent.reduce((s, r) => s + r.rating, 0) / recent.length) * 100) / 100;
    const previousAverage =
      Math.round((previous.reduce((s, r) => s + r.rating, 0) / previous.length) * 100) / 100;
    const delta = recentAverage - previousAverage;
    trend = {
      recentAverage,
      previousAverage,
      verdict:
        delta > TREND_VERDICT_EPSILON
          ? "en_hausse"
          : delta < -TREND_VERDICT_EPSILON
            ? "en_baisse"
            : "stable",
    };
  }

  const alertFloor = now.getTime() - RECENT_ALERT_DAYS * DAY_MS;
  const unansweredNegative = valid
    .filter((r) => r.rating <= 2 && !r.replied && r.time >= alertFloor && r.time <= now.getTime())
    .sort((a, b) => b.time - a.time)
    .map((r) => ({
      id: r.id,
      rating: r.rating,
      daysAgo: Math.floor((now.getTime() - r.time) / DAY_MS),
    }));

  return {
    totalReviews: total,
    averageRating,
    distribution,
    replyRatePct,
    trend,
    unansweredNegative,
    label: "analyse des avis enregistrés dans NODAQ — pas un flux temps réel des plateformes",
  };
}
