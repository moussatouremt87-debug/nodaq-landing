import { describe, expect, it } from "vitest";
import { simulateMaterialPrices } from "../src/materialScenario.js";

/*
 * Simulation prix matières (ticket 3.3) — modèle PUR, déterministe : le stock
 * (quantités × coûts de remplacement) revalorisé sous un scénario de prix.
 */

const ITEMS = [
  { name: "Câble cuivre 3G2,5", unit: "mètre", quantity: 500, unitCostCents: 120 },
  { name: "Disjoncteur 20A", unit: "unité", quantity: 40, unitCostCents: 850 },
  { name: "Gaine ICTA", unit: "mètre", quantity: 200, unitCostCents: 0 }, // coût non renseigné
];

describe("simulateMaterialPrices", () => {
  it("scénario ciblé : seul l'article visé bouge, totaux et delta corrects", () => {
    const result = simulateMaterialPrices(ITEMS, {
      items: [{ itemName: "Câble cuivre 3G2,5", changePct: 10 }],
    });
    const copper = result.lines.find((l) => l.name === "Câble cuivre 3G2,5");
    expect(copper).toMatchObject({
      changePct: 10,
      newUnitCostCents: 132,
      valueCents: 60_000,
      newValueCents: 66_000,
      deltaCents: 6_000,
    });
    expect(result.lines.find((l) => l.name === "Disjoncteur 20A")?.deltaCents).toBe(0);
    expect(result.totals).toMatchObject({
      valueCents: 94_000, // 60 000 + 34 000 + 0
      newValueCents: 100_000,
      deltaCents: 6_000,
      deltaPct: 6.4,
    });
    expect(result.unmatched).toEqual([]);
  });

  it("scénario global : tout bouge, l'override par article gagne", () => {
    const result = simulateMaterialPrices(ITEMS, {
      globalChangePct: 5,
      items: [{ itemName: "Disjoncteur 20A", changePct: -20 }],
    });
    expect(result.lines.find((l) => l.name === "Câble cuivre 3G2,5")?.changePct).toBe(5);
    expect(result.lines.find((l) => l.name === "Disjoncteur 20A")).toMatchObject({
      changePct: -20,
      newUnitCostCents: 680,
    });
  });

  it("nom inconnu dans le scénario : signalé, jamais silencieux", () => {
    const result = simulateMaterialPrices(ITEMS, {
      items: [{ itemName: "Cuivre nu", changePct: 10 }],
    });
    expect(result.unmatched).toEqual(["Cuivre nu"]);
    expect(result.totals.deltaCents).toBe(0);
  });

  it("coût non renseigné : valeur 0 visible, deltaPct null si valorisation nulle", () => {
    const result = simulateMaterialPrices(
      [{ name: "Gaine", unit: "mètre", quantity: 100, unitCostCents: 0 }],
      { globalChangePct: 50 },
    );
    expect(result.lines[0]).toMatchObject({ valueCents: 0, newValueCents: 0 });
    expect(result.totals.deltaPct).toBeNull();
  });

  it("bornes : -90 %..+500 % (une faute de frappe ne produit pas d'absurdité)", () => {
    expect(() =>
      simulateMaterialPrices(ITEMS, { globalChangePct: 1000 }),
    ).toThrow();
    const floor = simulateMaterialPrices(
      [{ name: "X", unit: "u", quantity: 1, unitCostCents: 100 }],
      { globalChangePct: -90 },
    );
    expect(floor.lines[0]?.newUnitCostCents).toBe(10);
  });
});
