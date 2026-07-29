import { describe, expect, it } from "vitest";
import { buildStaffingPlan } from "../src/staffingPlan.js";

/*
 * Plannings RH (ticket 3.5) — modèle PUR, déterministe, explicable :
 * capacité (heures contractuelles − absences) vs charge ESTIMÉE (prévision
 * de ventes ÷ taux horaire configurable), verdicts chiffrés, jamais une
 * charge fabriquée sans prévision.
 */

const NOW = new Date("2026-07-29T12:00:00Z");

const TEAM = [
  { id: "s1", name: "Karim", weeklyHours: 35, active: true },
  { id: "s2", name: "Lucie", weeklyHours: 35, active: true },
  { id: "s3", name: "Ancien", weeklyHours: 35, active: false }, // inactif : ignoré
];

describe("buildStaffingPlan", () => {
  it("capacité mensuelle = heures hebdo x 4,348, absences déduites en jours ouvrés", () => {
    const plan = buildStaffingPlan(
      TEAM,
      // Karim : 2 semaines de congés en août (14 j calendaires ~ 10 j ouvrés = 70 h).
      [{ staffId: "s1", startDate: "2026-08-03", endDate: "2026-08-16" }],
      [],
      NOW,
    );
    const august = plan.months.find((m) => m.month === "2026-08")!;
    // 70 h hebdo x 4,348 = 304 h brutes ; 14 j x 5/7 x 7 h = 70 h d'absence.
    expect(august.capacityHours).toBe(304 - 70);
    expect(august.absenceHours).toBe(70);
    expect(august.verdict).toBe("inconnu"); // pas de prévision fournie
    expect(plan.activeStaff).toBe(2);
    expect(plan.label).toContain("estimation");
  });

  it("verdicts chiffrés : sous-capacité, sur-capacité, équilibre (tolérance 10 %)", () => {
    const plan = buildStaffingPlan(
      TEAM,
      [],
      [
        { month: "2026-08", revenueCents: 3_000_000 }, // 30 000 € ÷ 60 €/h = 500 h > 304 h
        { month: "2026-09", revenueCents: 600_000 }, // 100 h << 304 h
        { month: "2026-10", revenueCents: 1_800_000 }, // 300 h ~ 304 h
      ],
      NOW,
    );
    const [august, september, october] = plan.months;
    expect(august).toMatchObject({
      estimatedWorkloadHours: 500,
      gapHours: 304 - 500,
      verdict: "sous-capacite",
    });
    expect(august!.reason).toContain("SOUS-capacité de 196 h");
    expect(september).toMatchObject({ verdict: "sur-capacite", estimatedWorkloadHours: 100 });
    expect(october?.verdict).toBe("equilibre");
  });

  it("taux horaire configurable : la charge estimée suit, jamais un chiffre caché", () => {
    const plan = buildStaffingPlan(
      TEAM,
      [],
      [{ month: "2026-08", revenueCents: 3_000_000 }],
      NOW,
      { hourlyRateCents: 10_000 }, // 100 €/h -> 300 h
    );
    expect(plan.months[0]?.estimatedWorkloadHours).toBe(300);
    expect(plan.hourlyRateCents).toBe(10_000);
    expect(plan.months[0]?.reason).toContain("100 €/h");
  });

  it("équipe vide ou lignes invalides : capacité 0, jamais une exception", () => {
    const plan = buildStaffingPlan(
      ["garbage" as never, { id: "x", name: "X", weeklyHours: -5, active: true } as never],
      [{ staffId: "x", startDate: "invalide", endDate: "2026-08-01" }],
      [{ month: "2026-08", revenueCents: 100_000 }],
      NOW,
    );
    expect(plan.activeStaff).toBe(0);
    expect(plan.months[0]).toMatchObject({ capacityHours: 0, verdict: "sous-capacite" });
  });
});
