import { describe, expect, it } from "vitest";
import { buildDepreciationPlan, bookValueAtYearEnd, wearRatioAtYearEnd } from "../src/depreciation.js";

/*
 * Moteur d'amortissement (2.19) — cas de référence CALCULÉS À LA MAIN.
 * Conventions : exercice civil ; linéaire prorata au jour (360 j) ;
 * dégressif au 1er du mois, coefficients CGI 39 A, basculement linéaire gelé.
 */

describe("linéaire", () => {
  it("10 000 € sur 5 ans, mise en service 01/04/2024 : 1 500 + 4×2 000 + 500", () => {
    const plan = buildDepreciationPlan({
      baseCents: 1_000_000,
      inServiceDate: "2024-04-01",
      durationMonths: 60,
      method: "LINEAIRE",
    });
    // Année 1 : 270/360 jours -> 150 000 c ; années pleines 200 000 c ; solde 50 000 c.
    expect(plan.lines.map((l) => [l.year, l.dotationCents])).toEqual([
      [2024, 150_000],
      [2025, 200_000],
      [2026, 200_000],
      [2027, 200_000],
      [2028, 200_000],
      [2029, 50_000],
    ]);
    expect(plan.totalCents).toBe(1_000_000);
  });

  it("année bissextile, mise en service 29/02/2024 : 302/360 jours la première année", () => {
    const plan = buildDepreciationPlan({
      baseCents: 360_000,
      inServiceDate: "2024-02-29",
      durationMonths: 36,
      method: "LINEAIRE",
    });
    // Taux 1/3 par an = 120 000 c ; jours écoulés = 30 + 28 = 58 -> 302 restants.
    expect(plan.lines[0]).toMatchObject({ year: 2024, dotationCents: Math.round(120_000 * (302 / 360)) });
    expect(plan.totalCents).toBe(360_000);
  });

  it("cession en cours de plan : l'exercice de cession est proratisé, le plan tronqué", () => {
    const plan = buildDepreciationPlan({
      baseCents: 1_000_000,
      inServiceDate: "2024-01-01",
      durationMonths: 60,
      method: "LINEAIRE",
      disposedAt: "2026-06-30",
    });
    // 2026 : jusqu'au 30/06 = 180/360 -> 100 000 c ; rien après.
    expect(plan.lines.map((l) => [l.year, l.dotationCents])).toEqual([
      [2024, 200_000],
      [2025, 200_000],
      [2026, 100_000],
    ]);
    expect(plan.lines.at(-1)?.endBookValueCents).toBe(500_000);
  });
});

describe("dégressif (CGI 39 A)", () => {
  it("100 000 € sur 5 ans (coef 1,75 -> 35 %), mise en service 15/07/2024 — bascule linéaire en 2027", () => {
    const plan = buildDepreciationPlan({
      baseCents: 10_000_000,
      inServiceDate: "2024-07-15",
      durationMonths: 60,
      method: "DEGRESSIF",
    });
    // Vérifié à la main : 2024 = 10 M×35 %×6/12 = 1 750 000 ; 2025 = 2 887 500 ;
    // 2026 = 1 876 875 ; 2027 : dég 1 219 969 < lin 3 485 625/2,5 = 1 394 250
    // -> bascule, annuité gelée 1 394 250 ; 2028 idem ; 2029 solde 697 125.
    expect(plan.lines.map((l) => [l.year, l.dotationCents])).toEqual([
      [2024, 1_750_000],
      [2025, 2_887_500],
      [2026, 1_876_875],
      [2027, 1_394_250],
      [2028, 1_394_250],
      [2029, 697_125],
    ]);
    expect(plan.totalCents).toBe(10_000_000);
  });

  it("coefficient 1,25 pour 3 ans : taux dégressif ~41,67 %", () => {
    const plan = buildDepreciationPlan({
      baseCents: 3_600_000,
      inServiceDate: "2024-01-01",
      durationMonths: 36,
      method: "DEGRESSIF",
    });
    // 2024 : 3 600 000 × (1/3×1,25) = 1 500 000. VNC 2 100 000.
    expect(plan.lines[0]?.dotationCents).toBe(1_500_000);
    expect(plan.totalCents).toBe(3_600_000);
  });
});

describe("VNC et usure", () => {
  it("VNC à toute fin d'exercice + % d'usure cohérents", () => {
    const input = {
      baseCents: 1_000_000,
      inServiceDate: "2024-04-01",
      durationMonths: 60,
      method: "LINEAIRE" as const,
    };
    expect(bookValueAtYearEnd(input, 2023)).toBe(1_000_000);
    expect(bookValueAtYearEnd(input, 2024)).toBe(850_000);
    expect(bookValueAtYearEnd(input, 2029)).toBe(0);
    expect(wearRatioAtYearEnd(input, 2027)).toBeCloseTo(0.75, 2);
  });
});

describe("terminaison (audit 2.19)", () => {
  it("micro-montant + durée longue : le plan TERMINE, borné, et somme exactement", () => {
    const plan = buildDepreciationPlan({
      baseCents: 20,
      inServiceDate: "2024-01-01",
      durationMonths: 600,
      method: "LINEAIRE",
    });
    expect(plan.totalCents).toBe(20);
    expect(plan.lines.length).toBeLessThanOrEqual(60);
    const declining = buildDepreciationPlan({
      baseCents: 7,
      inServiceDate: "2024-01-01",
      durationMonths: 180,
      method: "DEGRESSIF",
    });
    expect(declining.totalCents).toBe(7);
    expect(declining.lines.length).toBeLessThanOrEqual(60);
  });
});
