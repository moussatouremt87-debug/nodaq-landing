import { describe, expect, it } from "vitest";
import { scoreLatePayment } from "../src/dunning.js";
import { forecastTreasury } from "../src/treasury.js";

const NOW = new Date("2026-07-25T12:00:00Z");

describe("forecastTreasury", () => {
  it("projects the balance with the observed average daily net flow", () => {
    // 30 observed days, net +30_000 cents => +1_000/day.
    const forecast = forecastTreasury(
      100_000,
      [
        { amountCents: 90_000, side: "credit", settledAt: "2026-06-25T12:00:00.000Z" },
        { amountCents: 60_000, side: "debit", settledAt: "2026-07-10T12:00:00.000Z" },
      ],
      NOW,
    );
    expect(forecast.observedDays).toBe(30);
    expect(forecast.avgDailyNetFlowCents).toBe(1000);
    expect(forecast.points).toEqual([
      { horizonDays: 30, projectedBalanceCents: 130_000 },
      { horizonDays: 60, projectedBalanceCents: 160_000 },
      { horizonDays: 90, projectedBalanceCents: 190_000 },
    ]);
  });

  it("no transactions => flat projection at the current balance", () => {
    const forecast = forecastTreasury(50_000, [], NOW);
    expect(forecast.avgDailyNetFlowCents).toBe(0);
    expect(forecast.points.every((p) => p.projectedBalanceCents === 50_000)).toBe(true);
  });

  it("negative net flow projects a shrinking balance", () => {
    const forecast = forecastTreasury(
      10_000,
      [{ amountCents: 30_000, side: "debit", settledAt: "2026-06-25T12:00:00.000Z" }],
      NOW,
    );
    expect(forecast.avgDailyNetFlowCents).toBe(-1000);
    expect(forecast.points[0]?.projectedBalanceCents).toBe(10_000 - 30_000);
  });
});

describe("scoreLatePayment", () => {
  it("not yet due => zero score, low band", () => {
    const s = scoreLatePayment(
      { invoiceNumber: "F-1", amountCents: 100_000, dueDate: "2026-08-01", status: "pending" },
      NOW,
    );
    expect(s.daysOverdue).toBe(0);
    expect(s.band).toBe("low");
  });

  it("long overdue + large amount => high band with signals", () => {
    const s = scoreLatePayment(
      { invoiceNumber: "F-2", amountCents: 900_000, dueDate: "2026-04-01", status: "late" },
      NOW,
    );
    expect(s.daysOverdue).toBeGreaterThan(90);
    expect(s.band).toBe("high");
    expect(s.signals).toContain("large-amount");
  });

  it("moderately overdue small invoice => medium band", () => {
    const s = scoreLatePayment(
      { invoiceNumber: "F-3", amountCents: 50_000, dueDate: "2026-06-10", status: "late" },
      NOW,
    );
    expect(s.band).toBe("medium");
  });
});
