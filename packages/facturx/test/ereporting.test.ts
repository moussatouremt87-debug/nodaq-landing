import { describe, expect, it } from "vitest";
import { aggregateEReporting } from "../src/index.js";

/*
 * E-reporting (2.4) : ce qui part à l'administration est un AGRÉGAT. Les
 * tests vérifient surtout ce que le modèle refuse de faire — deviner la TVA,
 * convertir une devise, avaler une ligne inexploitable.
 */

const ledger = [
  { amountCents: 120_00, date: "2026-01-05", currency: "EUR" },
  { amountCents: 240_00, date: "2026-01-31", currency: null },
  { amountCents: 999_00, date: "2026-02-01", currency: "EUR" }, // hors période
  { amountCents: 500_00, date: "2026-01-10", currency: "USD" }, // autre devise
  { amountCents: null, date: "2026-01-12", currency: "EUR" }, // inexploitable
  { amountCents: 300_00, date: null, currency: "EUR" }, // inexploitable
];

describe("aggregateEReporting", () => {
  it("agrège la période, devise absente = EUR", () => {
    const result = aggregateEReporting(ledger, "2026-01-01", "2026-01-31");
    expect(result.transactionCount).toBe(2);
    expect(result.totalCents).toBe(360_00);
    expect(result.currency).toBe("EUR");
  });

  it("compte les exclusions, jamais silencieusement", () => {
    const result = aggregateEReporting(ledger, "2026-01-01", "2026-01-31");
    expect(result.outOfPeriodCount).toBe(1);
    expect(result.otherCurrencyCount).toBe(1);
    expect(result.unusableCount).toBe(2);
    // Chaque exclusion est aussi dite en clair à l'owner.
    expect(result.caveats.some((c) => c.includes("autre devise"))).toBe(true);
    expect(result.caveats.some((c) => c.includes("sans date"))).toBe(true);
  });

  it("ne convertit JAMAIS une devise étrangère", () => {
    const result = aggregateEReporting(
      [{ amountCents: 500_00, date: "2026-01-10", currency: "USD" }],
      "2026-01-01",
      "2026-01-31",
    );
    expect(result.totalCents).toBe(0);
    expect(result.transactionCount).toBe(0);
    expect(result.otherCurrencyCount).toBe(1);
  });

  it("TVA jamais dérivée : le facturier ne la porte pas", () => {
    const result = aggregateEReporting(ledger, "2026-01-01", "2026-01-31");
    expect(result.vatDerivable).toBe(false);
    expect(result.caveats.some((c) => c.includes("TVA non dérivable"))).toBe(true);
    // B2B/B2C non dérivable non plus : dit, jamais deviné.
    expect(result.caveats.some((c) => c.includes("B2B / B2C"))).toBe(true);
  });

  it("bornes incluses des deux côtés", () => {
    const result = aggregateEReporting(
      [
        { amountCents: 100, date: "2026-01-01", currency: "EUR" },
        { amountCents: 100, date: "2026-01-31", currency: "EUR" },
      ],
      "2026-01-01",
      "2026-01-31",
    );
    expect(result.transactionCount).toBe(2);
  });

  it("période invalide : refus, jamais un agrégat sur une fenêtre absurde", () => {
    expect(() => aggregateEReporting([], "2026-01-31", "2026-01-01")).toThrow();
    expect(() => aggregateEReporting([], "pas-une-date", "2026-01-31")).toThrow();
  });

  it("facturier vide : zéro assumé, pas d'erreur", () => {
    const result = aggregateEReporting([], "2026-01-01", "2026-01-31");
    expect(result.transactionCount).toBe(0);
    expect(result.totalCents).toBe(0);
  });
});
