import { describe, expect, it } from "vitest";
import { buildMarginReport, MARGIN_RULES_VERSION } from "../src/margin.js";
import type { CostEntry } from "../src/margin.js";
import type { ReportInvoice } from "../src/monthlyReport.js";

/*
 * Marge (2.8). Le danger est ASYMÉTRIQUE : une charge oubliée ne déplace pas
 * la marge au hasard, elle la fait toujours paraître meilleure. Les tests
 * portent donc d'abord sur ce que le rapport refuse d'affirmer.
 */

const INVOICES: ReportInvoice[] = [
  { date: "2026-06-10", amount: 60_000, currency: "EUR", status: "paid" },
  { date: "2026-06-20", amount: 40_000, currency: "EUR", status: "paid" },
];

function cost(category: string, amount: number, source: "fec" | "saisi" = "fec"): CostEntry {
  return { category, month: "2026-06", amountCents: amount * 100, source };
}

/** Tous les postes renseignés : le seul cas où un chiffre est un chiffre. */
const COMPLETE: CostEntry[] = [
  cost("achats", 30_000),
  cost("sous_traitance", 10_000),
  cost("main_oeuvre", 25_000),
  cost("services_exterieurs", 8_000),
  cost("impots_taxes", 2_000),
  cost("autres_charges", 1_000),
];

describe("config", () => {
  it("règles versionnées et datées", () => {
    expect(MARGIN_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("base incomplète : une BORNE, jamais un chiffre", () => {
  it("un poste manquant => borne supérieure, et le mot « AU PLUS » est dans la phrase", () => {
    const report = buildMarginReport(INVOICES, [cost("achats", 30_000)], "2026-06");
    const brute = report.levels.find((level) => level.level === "direct");
    expect(brute?.kind).toBe("borne_superieure");
    expect(brute?.missingCategories).toContain("Sous-traitance et travaux confiés");
    expect(brute?.reason).toContain("AU PLUS");
    expect(brute?.reason).toContain("INFÉRIEURE");
  });

  it("la borne est bien un PLAFOND : ajouter une charge ne peut que la faire baisser", () => {
    const partial = buildMarginReport(INVOICES, [cost("achats", 30_000)], "2026-06");
    const fuller = buildMarginReport(
      INVOICES,
      [cost("achats", 30_000), cost("sous_traitance", 10_000)],
      "2026-06",
    );
    const before = partial.levels.find((l) => l.level === "direct")?.marginCents ?? 0;
    const after = fuller.levels.find((l) => l.level === "direct")?.marginCents ?? 0;
    expect(after).toBeLessThan(before);
  });

  it("les postes manquants sont NOMMÉS, jamais supposés à zéro", () => {
    const report = buildMarginReport(INVOICES, [cost("achats", 30_000)], "2026-06");
    expect(report.missingCategories.map((category) => category.id)).toEqual([
      "sous_traitance",
      "main_oeuvre",
      "services_exterieurs",
      "impots_taxes",
      "autres_charges",
    ]);
  });

  it("aucune charge du tout : la marge d'exploitation reste une borne, pas 100 %", () => {
    const report = buildMarginReport(INVOICES, [], "2026-06");
    for (const level of report.levels) {
      expect(level.kind).toBe("borne_superieure");
      expect(level.reason).toContain("AU PLUS");
    }
  });
});

describe("base complète : un chiffre est un chiffre", () => {
  it("tous les postes renseignés => marge d'exploitation qualifiée « complete »", () => {
    const report = buildMarginReport(INVOICES, COMPLETE, "2026-06");
    const exploitation = report.levels.find((level) => level.level === "exploitation");
    expect(exploitation?.kind).toBe("complete");
    expect(exploitation?.missingCategories).toEqual([]);
    // 100 000 € de CA − 76 000 € de charges = 24 000 €.
    expect(exploitation?.marginCents).toBe(2_400_000);
    expect(exploitation?.reason).not.toContain("AU PLUS");
  });

  it("la marge brute ne retient QUE les coûts directs", () => {
    const report = buildMarginReport(INVOICES, COMPLETE, "2026-06");
    const brute = report.levels.find((level) => level.level === "direct");
    // 100 000 − (30 000 achats + 10 000 sous-traitance) = 60 000.
    expect(brute?.marginCents).toBe(6_000_000);
    expect(brute?.kind).toBe("complete");
  });

  it("les niveaux s'empilent : l'exploitation inclut les coûts directs", () => {
    const report = buildMarginReport(INVOICES, COMPLETE, "2026-06");
    const [brute, exploitation] = report.levels;
    expect(exploitation?.costCents).toBeGreaterThan(brute?.costCents ?? 0);
    expect(exploitation?.marginCents).toBeLessThan(brute?.marginCents ?? 0);
  });
});

describe("ce que le rapport REFUSE de conclure", () => {
  it("aucun chiffre d'affaires : pas de ratio, et c'est DIT", () => {
    const report = buildMarginReport([], COMPLETE, "2026-06");
    expect(report.levels).toEqual([]);
    expect(report.notEvaluated.some((line) => line.includes("dénominateur"))).toBe(true);
  });

  it("mois invalide : refus", () => {
    expect(() => buildMarginReport(INVOICES, [], "juin")).toThrow();
  });
});

describe("invariants", () => {
  it("le CA suit la MÊME règle qu'en 3.1 et 2.11 : brouillons et devises écartés", () => {
    const report = buildMarginReport(
      [
        ...INVOICES,
        { date: "2026-06-11", amount: 50_000, currency: "EUR", status: "draft" },
        { date: "2026-06-12", amount: 50_000, currency: "USD", status: "paid" },
      ],
      COMPLETE,
      "2026-06",
    );
    // Deux marges qui divergeraient du CA affiché ailleurs seraient pires
    // qu'une absence de marge.
    expect(report.revenueCents).toBe(10_000_000);
    expect(report.excludedCount).toBe(1);
    expect(report.unusableCount).toBe(1);
  });

  it("les charges d'un AUTRE mois n'entrent pas dans la marge du mois analysé", () => {
    const report = buildMarginReport(
      INVOICES,
      [...COMPLETE, { category: "achats", month: "2026-05", amountCents: 9_999_900, source: "fec" }],
      "2026-06",
    );
    const exploitation = report.levels.find((level) => level.level === "exploitation");
    expect(exploitation?.marginCents).toBe(2_400_000);
  });

  it("un poste inconnu est ignoré, jamais compté à l'aveugle", () => {
    const report = buildMarginReport(
      INVOICES,
      [...COMPLETE, { category: "poste_invente", month: "2026-06", amountCents: 500_000, source: "saisi" }],
      "2026-06",
    );
    expect(report.levels.find((level) => level.level === "exploitation")?.marginCents).toBe(
      2_400_000,
    );
  });

  it("plusieurs sources sur un même poste s'additionnent, et la provenance est portée", () => {
    const report = buildMarginReport(
      INVOICES,
      [cost("achats", 20_000, "fec"), cost("achats", 10_000, "saisi")],
      "2026-06",
    );
    const achats = report.costs.find((line) => line.category === "achats");
    expect(achats?.amountCents).toBe(3_000_000);
    expect(achats?.source).toBe("fec+saisi");
  });

  it("label PERMANENT : une charge oubliée embellit TOUJOURS la marge", () => {
    const report = buildMarginReport(INVOICES, COMPLETE, "2026-06");
    expect(report.label).toContain("meilleure qu'elle n'est");
    expect(report.label).toContain("expert-comptable");
  });

  it("PURE : deux appels identiques donnent le même rapport", () => {
    expect(buildMarginReport(INVOICES, COMPLETE, "2026-06")).toEqual(
      buildMarginReport(INVOICES, COMPLETE, "2026-06"),
    );
  });
});
