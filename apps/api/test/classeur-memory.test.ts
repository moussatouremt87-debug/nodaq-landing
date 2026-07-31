import { describe, expect, it } from "vitest";
import {
  applySupplierMemory,
  buildSupplierMemory,
  MIN_EVIDENCE,
  supplierKey,
} from "../src/classeurMemory.js";
import type { CorrectedDocument } from "../src/classeurMemory.js";
import type { DocExtraction } from "../src/classeur.js";

/*
 * Boucle d'apprentissage du classeur (2.16b). Ce qui est testé ici n'est pas
 * « est-ce que ça apprend » — c'est « est-ce que ça REFUSE d'apprendre » au
 * bon moment : une seule correction, une contradiction, un fournisseur
 * différent, une lecture du modèle qu'il faudrait écraser.
 */

const EMPTY: DocExtraction = {
  docType: "autre",
  supplierName: null,
  pieceNumber: null,
  docDate: null,
  currency: null,
  totalExclTax: null,
  totalTax: null,
  totalInclTax: null,
};

/** Un document dont l'humain a SAISI les champs de `extra` (journal 2.16). */
function corrected(
  supplierName: string,
  extra: Partial<DocExtraction> = {},
  humanCorrected = true,
): CorrectedDocument {
  return {
    final: { ...EMPTY, supplierName, ...extra },
    humanFields: humanCorrected ? (extra as Record<string, unknown>) : {},
  };
}

describe("supplierKey", () => {
  it("normalise casse, accents et ponctuation", () => {
    expect(supplierKey("Éléc Provence S.A.R.L.")).toBe(supplierKey("elec  provence sarl"));
  });

  it("ne fusionne PAS deux formes juridiques différentes", () => {
    // « Martin SARL » et « Martin SAS » sont deux entreprises : leurs
    // corrections ne doivent pas se mélanger.
    expect(supplierKey("Martin SARL")).not.toBe(supplierKey("Martin SAS"));
  });

  it("rejette un nom trop court ou absent", () => {
    expect(supplierKey(null)).toBeNull();
    expect(supplierKey("  ")).toBeNull();
    expect(supplierKey("AB")).toBeNull();
  });
});

describe("buildSupplierMemory", () => {
  it("UNE correction ne fait pas une règle", () => {
    const memories = buildSupplierMemory([corrected("Sogedis", { currency: "EUR" })]);
    expect(memories[0]?.fields).toHaveLength(0);
    expect(memories[0]?.documents).toBe(1);
  });

  it("deux corrections concordantes suffisent", () => {
    const memories = buildSupplierMemory([
      corrected("Sogedis", { currency: "EUR", docType: "facture_fournisseur" }),
      corrected("Sogedis", { currency: "EUR", docType: "facture_fournisseur" }),
    ]);
    const fields = memories[0]?.fields ?? [];
    expect(fields.find((f) => f.field === "currency")?.value).toBe("EUR");
    expect(fields.find((f) => f.field === "docType")?.evidence).toBe(MIN_EVIDENCE);
  });

  it("une CONTRADICTION n'est pas arbitrée : le champ n'est pas appris", () => {
    const memories = buildSupplierMemory([
      corrected("Sogedis", { docType: "facture_fournisseur" }),
      corrected("Sogedis", { docType: "facture_fournisseur" }),
      corrected("Sogedis", { docType: "recu" }),
    ]);
    expect(memories[0]?.fields.some((f) => f.field === "docType")).toBe(false);
    expect(memories[0]?.conflicts).toContain("docType");
  });

  it("un document NON corrigé n'est pas une vérité terrain", () => {
    const memories = buildSupplierMemory([
      corrected("Sogedis", { currency: "EUR" }, false),
      corrected("Sogedis", { currency: "EUR" }, false),
    ]);
    expect(memories).toHaveLength(0);
  });

  it("AUTO-ALIMENTATION : une valeur posée par la mémoire ne se conforte pas", () => {
    // Deux corrections humaines fondent la règle « EUR ». Un troisième
    // document reçoit EUR de la MÉMOIRE, et l'humain n'y corrige qu'un autre
    // champ : la preuve doit rester à 2, jamais monter à 3.
    const memories = buildSupplierMemory([
      corrected("Sogedis", { currency: "EUR" }),
      corrected("Sogedis", { currency: "EUR" }),
      {
        // `final` porte EUR (posé par la mémoire), le journal humain non.
        final: { ...EMPTY, supplierName: "Sogedis", currency: "EUR" },
        humanFields: { docType: "recu" },
      },
    ]);
    expect(memories[0]?.fields.find((f) => f.field === "currency")?.evidence).toBe(2);
  });

  it("une variation de CASSE n'est pas une contradiction humaine", () => {
    const memories = buildSupplierMemory([
      corrected("Sogedis", { currency: "EUR" }),
      corrected("SOGEDIS", { currency: "eur" }),
    ]);
    expect(memories[0]?.conflicts).toHaveLength(0);
    expect(memories[0]?.fields.find((f) => f.field === "currency")?.evidence).toBe(2);
  });

  it("regroupe sur le nom VALIDÉ, jamais sur celui lu par le modèle", () => {
    // C'est ce qui permet d'apprendre l'orthographe quand le modèle se trompe.
    const memories = buildSupplierMemory([
      {
        final: { ...EMPTY, supplierName: "Sogedis", currency: "EUR" },
        humanFields: { supplierName: "Sogedis" },
      },
      {
        final: { ...EMPTY, supplierName: "Sogedis", currency: "EUR" },
        humanFields: { supplierName: "Sogedis" },
      },
    ]);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.displayName).toBe("Sogedis");
  });
});

describe("applySupplierMemory", () => {
  const memories = buildSupplierMemory([
    corrected("Sogedis", { currency: "EUR", docType: "facture_fournisseur" }),
    corrected("Sogedis", { currency: "EUR", docType: "facture_fournisseur" }),
  ]);

  it("comble un trou et le DIT, avec le nombre de corrections", () => {
    const result = applySupplierMemory({ ...EMPTY, supplierName: "SOGEDIS" }, memories);
    expect(result.extraction.currency).toBe("EUR");
    expect(result.extraction.docType).toBe("facture_fournisseur");
    const currency = result.applied.find((a) => a.field === "currency");
    expect(currency?.kind).toBe("comble");
    expect(currency?.evidence).toBe(2);
    expect(result.matchedSupplier).not.toBeNull();
  });

  it("n'ÉCRASE JAMAIS une lecture du modèle : elle signale le désaccord", () => {
    const result = applySupplierMemory(
      { ...EMPTY, supplierName: "Sogedis", currency: "USD" },
      memories,
    );
    // La valeur lue reste — c'est l'humain qui tranchera.
    expect(result.extraction.currency).toBe("USD");
    const disagreement = result.applied.find((a) => a.field === "currency");
    expect(disagreement?.kind).toBe("desaccord");
    expect(disagreement?.modelValue).toBe("USD");
  });

  it("fournisseur inconnu : aucune application, aucun bruit", () => {
    const result = applySupplierMemory({ ...EMPTY, supplierName: "Inconnue SARL" }, memories);
    expect(result.applied).toHaveLength(0);
    expect(result.matchedSupplier).toBeNull();
    expect(result.extraction).toEqual({ ...EMPTY, supplierName: "Inconnue SARL" });
  });

  it("sans fournisseur lu : rien à rapprocher", () => {
    const result = applySupplierMemory(EMPTY, memories);
    expect(result.applied).toHaveLength(0);
    expect(result.matchedSupplier).toBeNull();
  });

  it("PURE : appliquer deux fois donne le même résultat", () => {
    const first = applySupplierMemory({ ...EMPTY, supplierName: "Sogedis" }, memories);
    const second = applySupplierMemory({ ...EMPTY, supplierName: "Sogedis" }, memories);
    expect(first).toEqual(second);
  });

  it("aucun montant n'est jamais appris", () => {
    const withAmounts = buildSupplierMemory([
      corrected("Sogedis", { totalInclTax: 120 }),
      corrected("Sogedis", { totalInclTax: 120 }),
    ]);
    // Un montant récurrent n'est PAS une règle : la facture suivante peut
    // porter n'importe quel montant, et le pré-remplir serait une invention.
    expect(withAmounts[0]?.fields.every((f) => !f.field.startsWith("total"))).toBe(true);
    const result = applySupplierMemory({ ...EMPTY, supplierName: "Sogedis" }, withAmounts);
    expect(result.extraction.totalInclTax).toBeNull();
  });
});
