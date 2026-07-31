import { describe, expect, it } from "vitest";
import { deriveCharges, parseFec } from "../src/index.js";
import { build, row } from "./fixtures.js";

/*
 * Dérivation des charges depuis un FEC (2.8). Ce qui est testé : que rien du
 * journal ne ressorte hors des agrégats, qu'un compte hors marge soit écarté
 * ET compté, et qu'un avoir réduise la charge au lieu d'être ignoré.
 */

function entriesOf(rows: string[][]) {
  const parsed = parseFec(build(rows));
  if (!parsed.ok) throw new Error("fixture invalide");
  return parsed.entries;
}

/**
 * Écritures d'achat/charge synthétiques — aucune donnée réelle. Chaque charge
 * porte sa contrepartie (401 fournisseur ou 512 banque) : le parseur rejette
 * un fichier déséquilibré, comme un vrai FEC.
 */
function charge(num: string, date: string, compte: string, lib: string, amount: string) {
  return [
    row({ journal: "AC", num, date, compte, lib, debit: amount }),
    row({ journal: "AC", num, date, compte: "401000", compteLib: "Fournisseurs", lib, credit: amount }),
  ];
}

const CHARGE_ROWS = [
  ...charge("10", "20260610", "607100", "Achat marchandises", "1200,00"),
  ...charge("11", "20260615", "601000", "Achat matières", "800,00"),
  ...charge("12", "20260620", "611000", "Sous-traitance", "500,00"),
  ...charge("13", "20260625", "641100", "Salaires", "3000,00"),
  ...charge("14", "20260628", "613200", "Loyer", "900,00"),
  // Classe 6 mais HORS marge : dotation (amortissement ≠ décaissement).
  ...charge("15", "20260630", "681120", "Dotation", "400,00"),
  // Mois suivant : ne doit pas se mélanger.
  ...charge("16", "20260705", "607100", "Achat marchandises", "100,00"),
];

describe("deriveCharges", () => {
  it("agrège par (mois, poste) et sépare les mois", () => {
    const { charges } = deriveCharges(entriesOf(CHARGE_ROWS));
    const june = charges.filter((charge) => charge.month === "2026-06");
    expect(june.find((c) => c.category === "achats")?.amountCents).toBe(200_000);
    expect(june.find((c) => c.category === "sous_traitance")?.amountCents).toBe(50_000);
    expect(june.find((c) => c.category === "main_oeuvre")?.amountCents).toBe(300_000);
    expect(june.find((c) => c.category === "services_exterieurs")?.amountCents).toBe(90_000);
    expect(charges.find((c) => c.month === "2026-07")?.amountCents).toBe(10_000);
  });

  it("les comptes hors marge sont écartés ET comptés : jamais un silence", () => {
    const { charges, excludedCount } = deriveCharges(entriesOf(CHARGE_ROWS));
    expect(excludedCount).toBe(1);
    expect(charges.some((charge) => charge.amountCents === 40_000)).toBe(false);
  });

  it("un compte NON RATTACHÉ (603) devient une charge `non_rattachees`, pas un silence", () => {
    // Avant l'audit 2.8, un 603 était compté avec les exclusions et
    // disparaissait : la marge pouvait s'annoncer complète en l'ignorant.
    const { charges, unmappedCount, excludedCount } = deriveCharges(
      entriesOf([
        ...charge("40", "20260610", "607100", "Achat", "1000,00"),
        ...charge("41", "20260615", "603700", "Variation de stocks", "300,00"),
      ]),
    );
    expect(unmappedCount).toBe(1);
    expect(excludedCount).toBe(0);
    const unmapped = charges.find((entry) => entry.category === "non_rattachees");
    expect(unmapped?.amountCents).toBe(30_000);
  });

  it("un avoir RÉDUIT la charge, il n'est pas ignoré", () => {
    const { charges } = deriveCharges(
      entriesOf([
        ...charge("20", "20260610", "607100", "Achat", "1000,00"),
        // Le rabais s'inscrit au crédit du 609, contrepartie au débit du 401.
        row({ journal: "AC", num: "21", date: "20260612", compte: "609700", lib: "Rabais", credit: "150,00" }),
        row({ journal: "AC", num: "21", date: "20260612", compte: "401000", compteLib: "Fournisseurs", lib: "Rabais", debit: "150,00" }),
      ]),
    );
    // Ignorer le rabais gonflerait la charge, donc écraserait la marge : le
    // biais irait dans le bon sens, mais le chiffre serait faux quand même.
    expect(charges.find((charge) => charge.category === "achats")?.amountCents).toBe(85_000);
  });

  it("AUCUN libellé, tiers ou ligne du journal ne sort de la dérivation", () => {
    // Donnée confidentielle (2.14) : seuls des agrégats en sortent.
    const derivation = deriveCharges(entriesOf(CHARGE_ROWS));
    const serialized = JSON.stringify(derivation);
    for (const secret of ["Salaires", "Loyer", "Achat marchandises", "607100", "641100"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("les comptes hors classe 6 ne sont jamais des charges", () => {
    const { charges } = deriveCharges(
      entriesOf([
        row({ num: "30", date: "20260610", compte: "41100001", aux: "CALPHA", lib: "Client", debit: "1000,00" }),
        row({ num: "30", date: "20260610", compte: "706000", compteLib: "Prestations", lib: "Prestations", credit: "1000,00" }),
      ]),
    );
    expect(charges).toEqual([]);
  });

  it("PURE et DÉTERMINISTE : deux dérivations du même fichier sont identiques", () => {
    const entries = entriesOf(CHARGE_ROWS);
    expect(deriveCharges(entries)).toEqual(deriveCharges(entries));
  });
});
