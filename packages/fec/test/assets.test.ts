import { describe, expect, it } from "vitest";
import { deriveFixedAssets } from "../src/assets.js";
import type { FecEntry } from "../src/parse.js";

/*
 * Dérivation immobilisations depuis le FEC (2.19) : 2x = valeur brute,
 * 28x = amortissements cumulés, incohérences SIGNALÉES, jamais corrigées
 * en silence — sortie = PROPOSITIONS pour l'écran de validation.
 */

function entry(compteNum: string, compteLib: string, date: string, debitCents: number, creditCents = 0): FecEntry {
  return {
    line: 2, journalCode: "OD", journalLib: "OD", ecritureNum: "1",
    ecritureDate: date, compteNum, compteLib, compAuxNum: null, compAuxLib: null,
    pieceRef: null, pieceDate: null, ecritureLib: compteLib,
    debitCents, creditCents, ecritureLet: null, dateLet: null, validDate: null,
  };
}

describe("deriveFixedAssets", () => {
  it("reconstitue brut 2x + amortissements 28x rattachés, avec catégorie devinée", () => {
    const proposals = deriveFixedAssets([
      entry("2182", "Fourgon atelier", "2023-03-10", 3_500_000),
      entry("28182", "Amort. matériel transport", "2023-12-31", 0, 875_000),
      entry("2183", "Parc informatique", "2024-01-15", 600_000),
    ]);
    expect(proposals).toHaveLength(2);
    const van = proposals.find((p) => p.accountNum === "2182")!;
    expect(van).toMatchObject({
      category: "vehicule",
      baseCents: 3_500_000,
      priorDepreciationCents: 875_000,
      inServiceDate: "2023-03-10",
    });
    expect(van.warnings).toHaveLength(0);
    const it2 = proposals.find((p) => p.accountNum === "2183")!;
    expect(it2.category).toBe("informatique");
    expect(it2.warnings).toContain("aucun amortissement 28x rattaché");
  });

  it("signale les incohérences (28x > 2x) sans corriger en silence, ignore les comptes soldés", () => {
    const proposals = deriveFixedAssets([
      entry("2154", "Machine", "2022-06-01", 1_000_000),
      entry("28154", "Amort. machine", "2024-12-31", 0, 1_200_000),
      entry("2155", "Outillage cédé", "2020-01-01", 500_000, 500_000),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ accountNum: "2154", priorDepreciationCents: 1_000_000 });
    expect(proposals[0]!.warnings.join(" ")).toContain("supérieurs à la valeur brute");
  });
});
