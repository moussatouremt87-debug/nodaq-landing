import { describe, expect, it } from "vitest";
import { analyzeHourlyPerformance } from "../src/hourlyPerformance.js";

/*
 * Performance horaire (ticket 3.6) — modèle PUR, déterministe, explicable :
 * CA mensuel OBSERVÉ (factures, 3.1) ÷ heures travaillées ESTIMÉES depuis les
 * contrats actuels (absences déduites, mêmes conventions que 3.5), comparé à
 * un objectif de taux horaire configurable. Chaque verdict est chiffré et le
 * rapport est TOUJOURS labellisé estimation (pas de pointage en V1).
 */

const TEAM = [
  { id: "s1", weeklyHours: 35, active: true },
  { id: "s2", weeklyHours: 35, active: true },
  { id: "s3", weeklyHours: 35, active: false }, // inactif : ignoré
];

// 70 h hebdo x 4,348 = 304 h estimées par mois (mêmes arrondis que 3.5).
const MONTH_HOURS = 304;

describe("analyzeHourlyPerformance", () => {
  it("taux réalisé = CA ÷ heures estimées, verdicts vs objectif (tolérance 10 %)", () => {
    const report = analyzeHourlyPerformance(
      TEAM,
      [],
      [
        // 304 h x 60 €/h = 18 240 € -> pile l'objectif.
        { month: "2026-04", revenueCents: 1_824_000, invoiceCount: 4 },
        // 30 000 € ÷ 304 h ~ 98,7 €/h >> 66 €/h (objectif + 10 %).
        { month: "2026-05", revenueCents: 3_000_000, invoiceCount: 6 },
        // 6 000 € ÷ 304 h ~ 19,7 €/h << 54 €/h.
        { month: "2026-06", revenueCents: 600_000, invoiceCount: 2 },
      ],
    );
    const [april, may, june] = report.months;
    expect(april).toMatchObject({ revenuePerHourCents: 6_000, verdict: "conforme" });
    expect(may).toMatchObject({ workedHours: MONTH_HOURS, verdict: "au-dessus" });
    expect(may!.revenuePerHourCents).toBe(Math.round(3_000_000 / MONTH_HOURS));
    expect(june?.verdict).toBe("en-dessous");
    expect(june!.reason).toContain("EN-DESSOUS");
    expect(report.activeStaff).toBe(2);
    expect(report.targetRateCents).toBe(6_000);
    expect(report.label).toContain("estimation");
  });

  it("absences déduites : moins d'heures, taux réalisé plus haut", () => {
    const report = analyzeHourlyPerformance(
      TEAM,
      // s1 : 2 semaines en juin (14 j calendaires ~ 10 j ouvrés = 70 h).
      [{ staffId: "s1", startDate: "2026-06-01", endDate: "2026-06-14" }],
      [{ month: "2026-06", revenueCents: 1_824_000, invoiceCount: 3 }],
    );
    const june = report.months[0]!;
    expect(june.absenceHours).toBe(70);
    expect(june.workedHours).toBe(MONTH_HOURS - 70);
    expect(june.revenuePerHourCents).toBe(Math.round(1_824_000 / (MONTH_HOURS - 70)));
    expect(june.verdict).toBe("au-dessus"); // 18 240 € sur 234 h ~ 78 €/h
  });

  it("objectif configurable : verdicts et rapport suivent", () => {
    const report = analyzeHourlyPerformance(
      TEAM,
      [],
      [{ month: "2026-06", revenueCents: 1_824_000, invoiceCount: 3 }],
      { targetRateCents: 10_000 }, // 100 €/h -> 60 €/h réalisé = en-dessous
    );
    expect(report.targetRateCents).toBe(10_000);
    expect(report.months[0]?.verdict).toBe("en-dessous");
    expect(report.months[0]?.reason).toContain("100 €/h");
  });

  it("équipe vide : verdict inconnu, jamais une division par zéro", () => {
    const report = analyzeHourlyPerformance(
      [],
      [],
      [{ month: "2026-06", revenueCents: 500_000, invoiceCount: 1 }],
    );
    expect(report.months[0]).toMatchObject({
      workedHours: 0,
      revenuePerHourCents: null,
      verdict: "inconnu",
    });
  });

  it("mois vides de tête ignorés (avant l'activité) ; série toute à zéro = aucun mois", () => {
    const withLeading = analyzeHourlyPerformance(
      TEAM,
      [],
      [
        { month: "2026-03", revenueCents: 0, invoiceCount: 0 },
        { month: "2026-04", revenueCents: 1_000_000, invoiceCount: 2 },
        { month: "2026-05", revenueCents: 0, invoiceCount: 0 }, // trou APRÈS activité : compté
      ],
    );
    expect(withLeading.months.map((m) => m.month)).toEqual(["2026-04", "2026-05"]);
    expect(withLeading.months[1]?.verdict).toBe("en-dessous"); // 0 € réalisé, signal réel

    const empty = analyzeHourlyPerformance(TEAM, [], [
      { month: "2026-05", revenueCents: 0, invoiceCount: 0 },
    ]);
    expect(empty.months).toEqual([]);
    expect(empty.averageRateCents).toBeNull();
  });

  it("taux moyen pondéré et tendance sur la fenêtre", () => {
    const report = analyzeHourlyPerformance(
      TEAM,
      [],
      [
        { month: "2026-04", revenueCents: 1_216_000, invoiceCount: 2 }, // 40 €/h
        { month: "2026-05", revenueCents: 1_824_000, invoiceCount: 3 }, // 60 €/h
        { month: "2026-06", revenueCents: 2_432_000, invoiceCount: 4 }, // 80 €/h
      ],
    );
    // Moyenne pondérée = ΣCA ÷ Σheures = 5 472 000 ÷ 912 = 6 000 c/h.
    expect(report.averageRateCents).toBe(6_000);
    expect(report.trendCentsPerMonth).toBeGreaterThan(0);
  });

  it("lignes invalides filtrées, jamais une exception", () => {
    const report = analyzeHourlyPerformance(
      ["garbage" as never, { id: "x", weeklyHours: -5, active: true } as never],
      [{ staffId: "x", startDate: "invalide", endDate: "2026-06-01" }],
      [{ month: "2026-06", revenueCents: 100_000, invoiceCount: 1 }],
    );
    expect(report.activeStaff).toBe(0);
    expect(report.months[0]?.verdict).toBe("inconnu");
  });
});
