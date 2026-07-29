import { describe, expect, it } from "vitest";
import { buildMonthlySeries, forecastSales } from "../src/salesForecast.js";

/*
 * Prévision des ventes (ticket 3.1) — modèle PUR, déterministe, explicable :
 * série mensuelle depuis les factures clients, régression linéaire clampée.
 */

const NOW = new Date("2026-07-29T12:00:00Z");

function invoice(date: string, amount: string | number, status = "paid") {
  return { date, amount, status };
}

describe("buildMonthlySeries", () => {
  it("groupe par mois, remplit les trous à 0, exclut le mois courant (incomplet)", () => {
    const series = buildMonthlySeries(
      [
        invoice("2026-05-10", "1000.00"),
        invoice("2026-05-20", 500),
        invoice("2026-03-01", "200.50"),
        invoice("2026-07-28", "9999.00"), // mois courant : exclu
      ],
      NOW,
      5,
    );
    expect(series.map((p) => p.month)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
    expect(series.find((p) => p.month === "2026-05")).toMatchObject({
      revenueCents: 150_000,
      invoiceCount: 2,
    });
    expect(series.find((p) => p.month === "2026-03")?.revenueCents).toBe(20_050);
    expect(series.find((p) => p.month === "2026-04")?.revenueCents).toBe(0);
  });

  it("ignore brouillons/annulées, montants invalides ou négatifs, dates absentes", () => {
    const series = buildMonthlySeries(
      [
        invoice("2026-05-10", "1000.00", "draft"),
        invoice("2026-05-10", "1000.00", "cancelled"),
        invoice("2026-05-10", "n/a"),
        invoice("2026-05-10", "-50.00"),
        { date: null, amount: "100.00", status: "paid" },
        invoice("2026-05-10", "300,25"), // virgule décimale tolérée
      ],
      NOW,
      4,
    );
    expect(series.find((p) => p.month === "2026-05")).toMatchObject({
      revenueCents: 30_025,
      invoiceCount: 1,
    });
  });
});

describe("forecastSales", () => {
  it("tendance haussière : la régression prolonge la pente, mois futurs corrects", () => {
    // 100 €, 200 €, 300 €, 400 € sur mars→juin => pente 100 €/mois.
    const series = buildMonthlySeries(
      [
        invoice("2026-03-15", "100.00"),
        invoice("2026-04-15", "200.00"),
        invoice("2026-05-15", "300.00"),
        invoice("2026-06-15", "400.00"),
      ],
      NOW,
      5,
    );
    const forecast = forecastSales(series, 3);
    expect(forecast.method).toBe("regression-lineaire");
    expect(forecast.observedMonths).toBe(4);
    expect(forecast.trendCentsPerMonth).toBe(10_000);
    expect(forecast.points.map((p) => p.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(forecast.points[0]?.revenueCents).toBe(50_000);
    expect(forecast.points[2]?.revenueCents).toBe(70_000);
  });

  it("les mois vides EN TÊTE (avant le début d'activité) ne cassent pas la tendance", () => {
    const series = buildMonthlySeries(
      [invoice("2026-05-15", "100.00"), invoice("2026-06-15", "200.00"), invoice("2026-04-15", "50.00")],
      NOW,
      12,
    );
    const forecast = forecastSales(series, 1);
    expect(forecast.observedMonths).toBe(3); // avril→juin, pas 12
    expect(forecast.method).toBe("regression-lineaire");
  });

  it("tendance baissière : jamais de prévision négative (clamp à 0)", () => {
    const series = buildMonthlySeries(
      [
        invoice("2026-04-15", "300.00"),
        invoice("2026-05-15", "150.00"),
        invoice("2026-06-15", "10.00"),
      ],
      NOW,
      3,
    );
    const forecast = forecastSales(series, 3);
    expect(forecast.trendCentsPerMonth).toBeLessThan(0);
    expect(forecast.points.every((p) => p.revenueCents >= 0)).toBe(true);
    expect(forecast.points[2]?.revenueCents).toBe(0);
  });

  it("historique court (< 3 mois actifs) : moyenne simple, pas de fausse tendance", () => {
    const series = buildMonthlySeries(
      [invoice("2026-05-15", "100.00"), invoice("2026-06-15", "300.00")],
      NOW,
      12,
    );
    const forecast = forecastSales(series, 2);
    expect(forecast.method).toBe("moyenne");
    expect(forecast.trendCentsPerMonth).toBe(0);
    expect(forecast.points.every((p) => p.revenueCents === 20_000)).toBe(true);
  });

  it("aucune facture : zéros signalés 'aucune-donnee'", () => {
    const forecast = forecastSales(buildMonthlySeries([], NOW, 6), 3);
    expect(forecast.method).toBe("aucune-donnee");
    expect(forecast.observedMonths).toBe(0);
    expect(forecast.points.every((p) => p.revenueCents === 0)).toBe(true);
  });
});
