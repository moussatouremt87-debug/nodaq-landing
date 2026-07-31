import { describe, expect, it } from "vitest";
import {
  applyTaxOverrides,
  buildTaxSchedule,
  DSN_EARLY_FILING_HEADCOUNT,
  TAX_CALENDAR_VERSION,
  TAX_OBLIGATIONS,
} from "../src/taxCalendar.js";
import type { TaxProfile } from "../src/taxCalendar.js";

/*
 * Échéancier fiscal & social (2.9). Ce qui compte ici n'est pas la longueur
 * du calendrier : c'est qu'il ne PRÉTENDE jamais savoir. Une date qui dépend
 * du SIREN est signalée comme approchée ; un régime non renseigné ne produit
 * pas d'échéance de TVA inventée ; aucun montant n'est jamais dérivé.
 */

const BASE: TaxProfile = {
  vatRegime: "reel_normal_mensuel",
  corporateTaxLiable: true,
  fiscalYearEndMonth: 12,
  payrollPeriodicity: "mensuelle",
  headcount: 8,
};

const ids = (schedule: { occurrences: { obligationId: string }[] }): string[] =>
  schedule.occurrences.map((o) => o.obligationId);

describe("catalogue", () => {
  it("config versionnée datée, chaque obligation sourcée", () => {
    expect(TAX_CALENDAR_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const obligation of Object.values(TAX_OBLIGATIONS)) {
      expect(obligation.label.length).toBeGreaterThan(5);
      expect(obligation.source.url).toMatch(/^https:\/\//);
      expect(obligation.source.label.length).toBeGreaterThan(5);
    }
  });
});

describe("TVA", () => {
  it("réel normal mensuel : une CA3 par mois, date APPROCHÉE (dépend du SIREN)", () => {
    const schedule = buildTaxSchedule(BASE, "2026-01-01", "2026-03-31");
    const ca3 = schedule.occurrences.filter((o) => o.obligationId === "tva_ca3");
    expect(ca3).toHaveLength(3);
    expect(ca3[0].dueDate).toBe("2026-01-15");
    // La borne BASSE de la fenêtre fait foi, et l'imprécision est dite.
    expect(ca3[0].dateIsApproximate).toBe(true);
    expect(ca3[0].basis).toContain("24");
    // La période déclarée est le mois PRÉCÉDENT — janvier déclare décembre.
    expect(ca3[0].period).toBe("décembre 2025");
  });

  it("réel normal trimestriel : une CA3 par trimestre", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, vatRegime: "reel_normal_trimestriel" },
      "2026-01-01",
      "2026-12-31",
    );
    expect(schedule.occurrences.filter((o) => o.obligationId === "tva_ca3")).toHaveLength(4);
  });

  it("réel simplifié : deux acomptes + la CA12, jamais de CA3", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, vatRegime: "reel_simplifie" },
      "2026-01-01",
      "2026-12-31",
    );
    expect(ids(schedule)).not.toContain("tva_ca3");
    expect(schedule.occurrences.filter((o) => o.obligationId === "tva_acompte_rsi")).toHaveLength(2);
    expect(schedule.occurrences.filter((o) => o.obligationId === "tva_ca12")).toHaveLength(1);
  });

  it("franchise en base : aucune échéance de TVA", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, vatRegime: "franchise" },
      "2026-01-01",
      "2026-12-31",
    );
    expect(ids(schedule).filter((id) => id.startsWith("tva"))).toHaveLength(0);
  });

  it("régime INCONNU : rien n'est proposé, et le trou est DIT", () => {
    const schedule = buildTaxSchedule({ ...BASE, vatRegime: "inconnu" }, "2026-01-01", "2026-12-31");
    expect(ids(schedule).filter((id) => id.startsWith("tva"))).toHaveLength(0);
    expect(schedule.gaps.some((gap) => gap.includes("Régime de TVA non renseigné"))).toBe(true);
  });
});

describe("impôt sur les sociétés", () => {
  it("quatre acomptes + le solde au 15 du 4e mois suivant la clôture", () => {
    const schedule = buildTaxSchedule(BASE, "2026-01-01", "2026-12-31");
    expect(schedule.occurrences.filter((o) => o.obligationId === "is_acompte")).toHaveLength(4);
    const solde = schedule.occurrences.find((o) => o.obligationId === "is_solde");
    // Clôture au 31/12 -> solde au 15 mai.
    expect(solde?.dueDate).toBe("2026-05-15");
  });

  it("exercice décalé : le solde suit la clôture", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, fiscalYearEndMonth: 6 },
      "2026-01-01",
      "2026-12-31",
    );
    expect(schedule.occurrences.find((o) => o.obligationId === "is_solde")?.dueDate).toBe(
      "2026-10-15",
    );
  });

  it("non soumise à l'IS : aucune échéance d'IS, et c'est dit", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, corporateTaxLiable: false },
      "2026-01-01",
      "2026-12-31",
    );
    expect(ids(schedule).filter((id) => id.startsWith("is_"))).toHaveLength(0);
    expect(schedule.gaps.some((gap) => gap.includes("non soumise à l'IS"))).toBe(true);
  });
});

describe("social", () => {
  it("DSN au 15 sous le seuil d'effectif, au 5 au-dessus", () => {
    const small = buildTaxSchedule(BASE, "2026-03-01", "2026-03-31");
    expect(small.occurrences.find((o) => o.obligationId === "dsn_mensuelle")?.dueDate).toBe(
      "2026-03-15",
    );
    const large = buildTaxSchedule(
      { ...BASE, headcount: DSN_EARLY_FILING_HEADCOUNT },
      "2026-03-01",
      "2026-03-31",
    );
    expect(large.occurrences.find((o) => o.obligationId === "dsn_mensuelle")?.dueDate).toBe(
      "2026-03-05",
    );
  });

  it("effectif inconnu : hypothèse basse ASSUMÉE et signalée", () => {
    const schedule = buildTaxSchedule({ ...BASE, headcount: null }, "2026-03-01", "2026-03-31");
    expect(schedule.occurrences.find((o) => o.obligationId === "dsn_mensuelle")?.dueDate).toBe(
      "2026-03-15",
    );
    expect(schedule.gaps.some((gap) => gap.includes("Effectif inconnu"))).toBe(true);
  });

  it("périodicité trimestrielle : quatre échéances URSSAF, pas de DSN mensuelle", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, payrollPeriodicity: "trimestrielle" },
      "2026-01-01",
      "2026-12-31",
    );
    expect(
      schedule.occurrences.filter((o) => o.obligationId === "urssaf_trimestrielle"),
    ).toHaveLength(4);
    expect(ids(schedule)).not.toContain("dsn_mensuelle");
  });

  it("aucune paie : rien de social, et le trou est dit", () => {
    const schedule = buildTaxSchedule(
      { ...BASE, payrollPeriodicity: "aucune" },
      "2026-01-01",
      "2026-12-31",
    );
    expect(ids(schedule)).not.toContain("dsn_mensuelle");
    expect(ids(schedule)).not.toContain("urssaf_trimestrielle");
    expect(schedule.gaps.some((gap) => gap.includes("Aucune paie"))).toBe(true);
  });
});

describe("CFE", () => {
  it("solde en décembre, acompte en juin explicitement CONDITIONNEL", () => {
    const schedule = buildTaxSchedule(BASE, "2026-01-01", "2026-12-31");
    expect(schedule.occurrences.find((o) => o.obligationId === "cfe_solde")?.dueDate).toBe(
      "2026-12-15",
    );
    const acompte = schedule.occurrences.find((o) => o.obligationId === "cfe_acompte");
    expect(acompte?.dueDate).toBe("2026-06-15");
    // Un acompte dû seulement au-delà d'un seuil ne se présente pas comme certain.
    expect(acompte?.basis).toContain("UNIQUEMENT");
  });
});

describe("fenêtre et invariants", () => {
  it("les occurrences sont dans la fenêtre et triées", () => {
    const schedule = buildTaxSchedule(BASE, "2026-04-01", "2026-06-30");
    for (const occurrence of schedule.occurrences) {
      expect(occurrence.dueDate >= "2026-04-01").toBe(true);
      expect(occurrence.dueDate <= "2026-06-30").toBe(true);
    }
    const dates = schedule.occurrences.map((o) => o.dueDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it("AUCUN montant n'est produit : le calendrier dit quand, pas combien", () => {
    const schedule = buildTaxSchedule(BASE, "2026-01-01", "2026-12-31");
    expect(schedule.occurrences.length).toBeGreaterThan(0);
    for (const occurrence of schedule.occurrences) {
      expect(occurrence).not.toHaveProperty("amountCents");
    }
    expect(JSON.stringify(schedule)).not.toMatch(/"amount/);
  });

  it("chaque occurrence explique SA date", () => {
    for (const occurrence of buildTaxSchedule(BASE, "2026-01-01", "2026-12-31").occurrences) {
      expect(occurrence.basis.length).toBeGreaterThan(20);
      expect(occurrence.period.length).toBeGreaterThan(3);
    }
  });

  it("fenêtre invalide : refus, jamais un calendrier absurde", () => {
    expect(() => buildTaxSchedule(BASE, "2026-12-31", "2026-01-01")).toThrow();
    expect(() => buildTaxSchedule(BASE, "pas-une-date", "2026-01-01")).toThrow();
  });

  it("fonction PURE : deux appels identiques donnent le même calendrier", () => {
    const a = buildTaxSchedule(BASE, "2026-01-01", "2026-12-31");
    const b = buildTaxSchedule(BASE, "2026-01-01", "2026-12-31");
    expect(a).toEqual(b);
  });
});

describe("applyTaxOverrides", () => {
  const schedule = buildTaxSchedule(BASE, "2026-03-01", "2026-03-31");

  it("sans surcharge : tout est « prévu », aucun montant inventé", () => {
    const planned = applyTaxOverrides(schedule, []);
    expect(planned.deadlines.every((d) => d.status === "prevu")).toBe(true);
    expect(planned.deadlines.every((d) => d.amountCents === null)).toBe(true);
    // Rien de chiffré => rien ne pèse sur la trésorerie.
    expect(planned.plannedOutflowCents).toBe(0);
    expect(planned.unpricedCount).toBe(planned.deadlines.length);
  });

  it("un montant DÉCLARÉ pèse sur la trésorerie, un montant absent JAMAIS", () => {
    const target = schedule.occurrences[0];
    const planned = applyTaxOverrides(schedule, [
      {
        obligationId: target.obligationId,
        dueDate: target.dueDate,
        amountCents: 4_200_00,
        status: "prevu",
        note: null,
      },
    ]);
    expect(planned.plannedOutflowCents).toBe(4_200_00);
    expect(planned.unpricedCount).toBe(planned.deadlines.length - 1);
  });

  it("payée ou non applicable : sortie du prévisionnel", () => {
    const target = schedule.occurrences[0];
    for (const status of ["paye", "non_applicable"] as const) {
      const planned = applyTaxOverrides(schedule, [
        {
          obligationId: target.obligationId,
          dueDate: target.dueDate,
          amountCents: 4_200_00,
          status,
          note: null,
        },
      ]);
      expect(planned.plannedOutflowCents).toBe(0);
      expect(planned.deadlines.find((d) => d.dueDate === target.dueDate)?.status).toBe(status);
    }
  });

  it("une surcharge orpheline est ignorée : un changement de régime ne ressuscite rien", () => {
    const planned = applyTaxOverrides(schedule, [
      {
        obligationId: "tva_ca3",
        dueDate: "2019-01-15",
        amountCents: 999_999_00,
        status: "prevu",
        note: null,
      },
    ]);
    expect(planned.plannedOutflowCents).toBe(0);
    expect(planned.deadlines.some((d) => d.dueDate === "2019-01-15")).toBe(false);
  });
});
