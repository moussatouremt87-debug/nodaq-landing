import { describe, expect, it } from "vitest";
import { buildMonthlySeries, fetchInvoiceWindow, forecastSales } from "../src/salesForecast.js";
import type { ForecastInvoice } from "../src/salesForecast.js";

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

  it("parse STRICT : un montant malformé est écarté, jamais tronqué en CA faux", () => {
    const series = buildMonthlySeries(
      [
        invoice("2026-05-10", "12abc"), // parseFloat aurait donné 12 €
        invoice("2026-05-10", "1,234.56"), // séparateur de milliers ambigu : rejeté
        invoice("2026-05-10", "1 234,56"), // idem
        invoice("2026-05-10", "200.00"),
      ],
      NOW,
      4,
    );
    expect(series.find((p) => p.month === "2026-05")).toMatchObject({
      revenueCents: 20_000,
      invoiceCount: 1,
    });
  });

  it("une facture en devise étrangère ne se somme pas avec des euros", () => {
    const series = buildMonthlySeries(
      [
        { date: "2026-05-10", amount: "100.00", currency: "USD", status: "paid" },
        { date: "2026-05-10", amount: "50.00", currency: "EUR", status: "paid" },
        { date: "2026-05-10", amount: "25.00", currency: null, status: "paid" },
      ],
      NOW,
      4,
    );
    expect(series.find((p) => p.month === "2026-05")?.revenueCents).toBe(7_500);
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

describe("fetchInvoiceWindow", () => {
  function pagedClient(pages: ForecastInvoice[][]) {
    const calls: { cursor?: string }[] = [];
    return {
      calls,
      listCustomerInvoices: ({ cursor }: { limit?: number; cursor?: string }) => {
        calls.push(cursor ? { cursor } : {});
        const index = cursor ? Number(cursor) : 0;
        return Promise.resolve({
          items: pages[index] ?? [],
          next_cursor: index + 1 < pages.length ? String(index + 1) : null,
        });
      },
    };
  }

  const recent = (n: number): ForecastInvoice[] =>
    Array.from({ length: n }, () => invoice("2026-06-10", "100.00"));
  const ancient = (n: number): ForecastInvoice[] =>
    Array.from({ length: n }, () => invoice("2020-01-10", "100.00"));

  it("s'arrête au cap de pages et SIGNALE la troncature (jamais « mois sans ventes »)", async () => {
    const client = pagedClient([recent(2), recent(2), recent(2), recent(2), recent(2), recent(2)]);
    const { invoices, truncated } = await fetchInvoiceWindow(client, NOW, { maxPages: 5 });
    expect(client.calls).toHaveLength(5);
    expect(invoices).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it("s'arrête dès qu'une page entière est antérieure à la fenêtre — sans troncature", async () => {
    const client = pagedClient([recent(3), ancient(3), ancient(3)]);
    const { invoices, truncated } = await fetchInvoiceWindow(client, NOW);
    expect(client.calls).toHaveLength(2);
    expect(invoices).toHaveLength(6);
    expect(truncated).toBe(false);
  });

  it("dernière page atteinte naturellement : pas de troncature", async () => {
    const client = pagedClient([recent(3), recent(1)]);
    const { invoices, truncated } = await fetchInvoiceWindow(client, NOW);
    expect(invoices).toHaveLength(4);
    expect(truncated).toBe(false);
  });
});
