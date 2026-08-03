import { describe, expect, it } from "vitest";
import {
  AFFAIRE_MARGIN_RULES_VERSION,
  computeAffaireMargin,
  type AffaireCostInput,
} from "../src/affaireMargin.js";

/*
 * Marge d'une affaire (ticket 4.1) — DÉTERMINISTE, zéro LLM.
 *
 * Le piège nommé par le ticket : afficher 100 % de marge sur une affaire vide.
 * C'est mathématiquement vrai (aucun coût imputé) et commercialement mortel.
 * Tous les cas ci-dessous sont calculés à la main.
 */

const EMPTY: AffaireCostInput = {
  quotedAmountCents: null,
  imputations: [],
  hoursWorked: null,
  hourlyCostCents: null,
  invoicedCents: 0,
  depositsCents: 0,
  retentionRateBps: null,
  estimatedMaterialCents: null,
};

const ht = (amountCents: number, subcontract = false) =>
  ({ targetType: "classeur_document", amountCents, amountBasis: "ht", subcontract }) as const;

describe("config versionnée", () => {
  it("porte une version datée", () => {
    expect(AFFAIRE_MARGIN_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("affaire vide", () => {
  it("aucun coût imputé => « données insuffisantes », JAMAIS 100 % de marge", () => {
    const result = computeAffaireMargin({ ...EMPTY, quotedAmountCents: 1_200_000 });
    expect(result.kind).toBe("donnees_insuffisantes");
    // Le type ne DOIT pas porter de marge : un écran ne peut pas en afficher une.
    expect("marginCents" in result).toBe(false);
  });

  it("dit CE QUI manque, au lieu de se taire", () => {
    const result = computeAffaireMargin({ ...EMPTY, quotedAmountCents: 1_200_000 });
    if (result.kind !== "donnees_insuffisantes") throw new Error("cas attendu");
    expect(result.missing).toContain("couts");
  });
});

describe("affaire sans devis", () => {
  it("affiche les coûts et AUCUNE marge (une marge sans devis serait inventée)", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      imputations: [ht(45_000), ht(30_000)],
    });
    expect(result.kind).toBe("couts_seuls");
    if (result.kind !== "couts_seuls") throw new Error("cas attendu");
    expect(result.materialCents).toBe(75_000);
    expect("marginCents" in result).toBe(false);
  });
});

describe("marge complète", () => {
  const complet: AffaireCostInput = {
    ...EMPTY,
    quotedAmountCents: 1_200_000,
    imputations: [ht(300_000), ht(50_000), ht(150_000, true)],
    hoursWorked: 40,
    hourlyCostCents: 3_500,
    estimatedMaterialCents: 400_000,
  };

  it("matière + main-d'oeuvre + sous-traitance, calculés à la main", () => {
    const result = computeAffaireMargin(complet);
    if (result.kind !== "marge") throw new Error("cas attendu");
    expect(result.materialCents).toBe(350_000);
    expect(result.subcontractCents).toBe(150_000);
    // 40 h × 35,00 € = 1 400,00 €
    expect(result.labourCents).toBe(140_000);
    // 1 200 000 − (350 000 + 140 000 + 150 000) = 560 000
    expect(result.marginCents).toBe(560_000);
  });

  it("écart budget matière : réel vs prévu, en euros ET en points de base", () => {
    const result = computeAffaireMargin(complet);
    if (result.kind !== "marge") throw new Error("cas attendu");
    // 350 000 réel − 400 000 prévu = −50 000 (sous le budget)
    expect(result.budgetGap?.deltaCents).toBe(-50_000);
    // −50 000 / 400 000 = −12,5 % = −1250 bps
    expect(result.budgetGap?.deltaBps).toBe(-1250);
  });

  it("sans coût matière prévu, l'écart n'est pas inventé : il est null", () => {
    const result = computeAffaireMargin({ ...complet, estimatedMaterialCents: null });
    if (result.kind !== "marge") throw new Error("cas attendu");
    expect(result.budgetGap).toBeNull();
  });
});

describe("coût de main-d'oeuvre inconnu — le cas majoritaire aujourd'hui", () => {
  it("heures connues mais coût horaire absent => marge en BORNE SUPÉRIEURE, jamais exacte", () => {
    // Compter zéro heure de travail gonfle la marge. L'erreur est asymétrique :
    // une marge trop belle fait accepter un chantier qui perd de l'argent.
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(200_000)],
      hoursWorked: 30,
      hourlyCostCents: null,
    });
    expect(result.kind).toBe("marge_borne_superieure");
    if (result.kind !== "marge_borne_superieure") throw new Error("cas attendu");
    expect(result.upperBoundCents).toBe(800_000);
    expect(result.missing).toContain("cout_horaire");
  });

  it("coût horaire connu mais heures inconnues => borne supérieure aussi", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(200_000)],
      hoursWorked: null,
      hourlyCostCents: 3_500,
    });
    expect(result.kind).toBe("marge_borne_superieure");
    if (result.kind !== "marge_borne_superieure") throw new Error("cas attendu");
    expect(result.missing).toContain("heures");
  });

  it("zéro heure DÉCLARÉE n'est pas une heure inconnue : la marge est exacte", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(200_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
    });
    expect(result.kind).toBe("marge");
    if (result.kind !== "marge") throw new Error("cas attendu");
    expect(result.labourCents).toBe(0);
  });
});

describe("montants en TTC — jamais convertis en HT", () => {
  it("une pièce TTC ne rentre PAS dans le coût HT, et c'est DIT", () => {
    // Sans le taux réel de la pièce, un HT « reconstitué » est un chiffre
    // inventé. On le tient à part et on le compte.
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [
        ht(200_000),
        { targetType: "classeur_document", amountCents: 60_000, amountBasis: "ttc", subcontract: false },
      ],
    });
    if (result.kind !== "marge_borne_superieure") throw new Error("cas attendu");
    expect(result.materialCents).toBe(200_000);
    expect(result.ttcOnlyCount).toBe(1);
    expect(result.ttcOnlyCents).toBe(60_000);
    expect(result.missing).toContain("pieces_ttc");
  });

  it("une pièce SANS montant est comptée et signalée, jamais comptée pour zéro", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [
        ht(200_000),
        { targetType: "transaction_bancaire", amountCents: null, amountBasis: null, subcontract: false },
      ],
    });
    if (result.kind !== "marge_borne_superieure") throw new Error("cas attendu");
    expect(result.unknownAmountCount).toBe(1);
    expect(result.missing).toContain("montants_inconnus");
  });
});

describe("retenue de garantie (US-8/US-9)", () => {
  it("EXCLUE du reste à facturer, et exposée à part", () => {
    // Relancer un client sur sa retenue est la faute qui coûte un client.
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(400_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
      invoicedCents: 600_000,
      retentionRateBps: 500,
    });
    if (result.kind !== "marge") throw new Error("cas attendu");
    // 5 % de 1 000 000 = 50 000, mis de côté
    expect(result.retentionCents).toBe(50_000);
    // reste à facturer = 1 000 000 − 600 000 − 50 000 (retenue exclue)
    expect(result.remainingToInvoiceCents).toBe(350_000);
  });

  it("sans taux de retenue, aucune retenue inventée", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(400_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
      invoicedCents: 600_000,
    });
    if (result.kind !== "marge") throw new Error("cas attendu");
    expect(result.retentionCents).toBe(0);
    expect(result.remainingToInvoiceCents).toBe(400_000);
  });
});

describe("acomptes", () => {
  it("un acompte encaissé n'est JAMAIS de la marge acquise", () => {
    const withDeposit = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(400_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
      depositsCents: 300_000,
    });
    const without = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 1_000_000,
      imputations: [ht(400_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
    });
    if (withDeposit.kind !== "marge" || without.kind !== "marge") throw new Error("cas attendu");
    // L'acompte est de la trésorerie encaissée, pas un gain : la marge est la même.
    expect(withDeposit.marginCents).toBe(without.marginCents);
    expect(withDeposit.depositsCents).toBe(300_000);
  });
});

describe("affaire terminée", () => {
  it("se calcule comme les autres — rien n'est figé, la vérité peut encore bouger", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 800_000,
      imputations: [ht(300_000), ht(100_000, true)],
      hoursWorked: 20,
      hourlyCostCents: 3_000,
      invoicedCents: 800_000,
    });
    if (result.kind !== "marge") throw new Error("cas attendu");
    // 800 000 − (300 000 + 60 000 + 100 000) = 340 000
    expect(result.marginCents).toBe(340_000);
    expect(result.remainingToInvoiceCents).toBe(0);
  });
});

describe("garde-fous arithmétiques", () => {
  it("un dépassement donne une marge NÉGATIVE, jamais bornée à zéro", () => {
    // Un chantier qui perd de l'argent doit se voir. Borner à 0 serait mentir
    // dans le sens rassurant, celui qu'on ne vérifie pas.
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 100_000,
      imputations: [ht(250_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
    });
    if (result.kind !== "marge") throw new Error("cas attendu");
    expect(result.marginCents).toBe(-150_000);
  });

  it("un sur-facturé ne rend pas un reste à facturer négatif", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 100_000,
      imputations: [ht(10_000)],
      hoursWorked: 0,
      hourlyCostCents: 3_500,
      invoicedCents: 150_000,
    });
    if (result.kind !== "marge") throw new Error("cas attendu");
    expect(result.remainingToInvoiceCents).toBe(0);
  });

  it("tous les montants rendus sont des ENTIERS de centimes", () => {
    const result = computeAffaireMargin({
      ...EMPTY,
      quotedAmountCents: 999_999,
      imputations: [ht(333_333)],
      hoursWorked: 7,
      hourlyCostCents: 3_333,
      retentionRateBps: 333,
    });
    if (result.kind !== "marge") throw new Error("cas attendu");
    for (const value of [
      result.materialCents,
      result.labourCents,
      result.marginCents,
      result.retentionCents,
      result.remainingToInvoiceCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
