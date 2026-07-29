import { describe, expect, it } from "vitest";
import { endOfLifeAssets, estimateIsImpact, renewalWall } from "../src/capex.js";
import type { RegistryAsset } from "../src/capex.js";

/*
 * Impact trésorerie du registre (2.19). LE test qui compte : une dotation
 * n'entre JAMAIS comme décaissement — seuls l'économie d'IS estimée
 * (labellisée) et le CAPEX de renouvellement (scénario) sortent d'ici.
 */

const NOW = new Date("2026-07-29T12:00:00Z");

function asset(overrides: Partial<RegistryAsset>): RegistryAsset {
  return {
    id: "a1",
    label: "Fourgon",
    baseCents: 3_500_000,
    inServiceDate: "2023-01-01",
    durationMonths: 60,
    method: "LINEAIRE",
    renewalCostCents: null,
    status: "ACTIF",
    ...overrides,
  };
}

describe("estimateIsImpact", () => {
  it("économie d'IS = dotations de l'exercice x taux marginal, TOUJOURS labellisée estimation", () => {
    const impact = estimateIsImpact([asset({})], NOW);
    // Dotation 2026 (année pleine) : 3 500 000 / 5 = 700 000 c.
    expect(impact.currentYearDepreciationCents).toBe(700_000);
    expect(impact.estimatedTaxSavingCents).toBe(175_000); // 25 %
    expect(impact.label).toContain("estimation");
    expect(impact.upcomingInstallments[0]).toBe("2026-09-15");
    // GARDE dotation ≠ décaissement : AUCUNE sortie de ce module n'égale la
    // dotation elle-même — seul l'effet fiscal (réduit) en sort.
    expect(impact.estimatedTaxSavingCents).toBeLessThan(impact.currentYearDepreciationCents);
  });

  it("taux réduit si le bénéfice est présumé sous le plafond", () => {
    const impact = estimateIsImpact([asset({})], NOW, { assumeProfitAboveCapEur: false });
    expect(impact.marginalRate).toBe(0.15);
  });
});

describe("mur de renouvellement + fin de vie", () => {
  it("un asset en fin de plan dans l'horizon apparaît au trimestre de fin, CAPEX = base par défaut", () => {
    const wall = renewalWall([asset({})], NOW, 24);
    // Plan 2023-2027 (mise en service 01/01/2023, 5 ans) -> mur 2027-Q4.
    expect(wall).toEqual([
      { quarter: "2027-Q4", capexCents: 3_500_000, assets: [{ id: "a1", label: "Fourgon" }] },
    ]);
    // renewalCost éditable prime sur la base historique.
    expect(renewalWall([asset({ renewalCostCents: 4_200_000 })], NOW)[0]?.capexCents).toBe(
      4_200_000,
    );
  });

  it("fin de vie : >= 80 % amorti et ACTIF seulement", () => {
    // 2023->2026 : 4/5 amorti fin d'exercice = 80 % pile -> fin de vie.
    expect(endOfLifeAssets([asset({})], NOW)).toHaveLength(1);
    // Récent : loin du seuil.
    expect(endOfLifeAssets([asset({ id: "a0", inServiceDate: "2025-06-01" })], NOW)).toHaveLength(0);
    const old = asset({ id: "a2", inServiceDate: "2020-01-01" });
    expect(endOfLifeAssets([old], NOW)).toHaveLength(1);
    expect(endOfLifeAssets([asset({ id: "a3", status: "CEDE", inServiceDate: "2020-01-01" })], NOW)).toHaveLength(0);
  });
});
