import { describe, expect, it } from "vitest";
import {
  AFFAIRE_SUGGESTION_RULES_VERSION,
  buildSupplierHistory,
  suggestAffaires,
  type SuggestionAffaire,
} from "../src/affaireSuggestion.js";

/*
 * F2 — photo → imputation, le moteur de suggestion.
 *
 * La question que chaque cas pose : « préférerait-on cette suggestion, ou rien
 * du tout ? » Une dépense rattachée au mauvais chantier fabrique DEUX marges
 * fausses et aucune des deux ne se voit — donc l'abstention est souvent la
 * bonne réponse, et elle est testée aussi sévèrement que les suggestions.
 */

const chantier = (over: Partial<SuggestionAffaire> = {}): SuggestionAffaire => ({
  id: "aff-1",
  reference: "2026-001",
  label: "Cuisine Martin",
  status: "EN_COURS",
  startDate: "2026-05-01",
  plannedEndDate: "2026-07-31",
  actualEndDate: null,
  ...over,
});

describe("config versionnée", () => {
  it("porte une version datée", () => {
    expect(AFFAIRE_SUGGESTION_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("abstention — « aucune suggestion » est une réponse", () => {
  it("aucune affaire ouverte : on ne propose pas un chantier terminé", () => {
    // Rattacher la facture d'aujourd'hui à un chantier livré en mars est une
    // suggestion visiblement absurde ; elle détruirait la confiance d'un coup.
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-06-10" },
      [chantier({ status: "TERMINEE" }), chantier({ id: "aff-2", status: "ARCHIVEE" })],
      [],
    );
    expect(result.kind).toBe("abstention");
    if (result.kind !== "abstention") throw new Error("cas attendu");
    expect(result.why).toBe("aucune_affaire_ouverte");
  });

  it("photo illisible (ni fournisseur ni date) : on s'abstient au lieu de deviner", () => {
    const result = suggestAffaires({ supplierName: null, docDate: null }, [chantier()], []);
    if (result.kind !== "abstention") throw new Error("cas attendu");
    expect(result.why).toBe("piece_illisible");
  });

  it("plusieurs chantiers ouverts couvrent la même date : aucun gagnant arbitraire", () => {
    // C'est le cas NORMAL d'un artisan qui mène trois chantiers de front. La
    // date ne départage rien, et le prétendre serait un mensonge commode.
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-06-10" },
      [chantier(), chantier({ id: "aff-2", reference: "2026-002", label: "Salle de bain" })],
      [],
    );
    if (result.kind !== "abstention") throw new Error("cas attendu");
    expect(result.why).toBe("signaux_partages");
  });

  it("une pièce HORS de toutes les périodes, avec plusieurs chantiers : abstention", () => {
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2025-01-05" },
      [chantier(), chantier({ id: "aff-2" })],
      [],
    );
    if (result.kind !== "abstention") throw new Error("cas attendu");
    expect(result.why).toBe("aucun_signal");
  });
});

describe("historique du tenant — le signal que l'utilisateur a produit lui-même", () => {
  it("« vous avez déjà rattaché ce fournisseur ici » l'emporte, avec son compte de preuves", () => {
    const result = suggestAffaires(
      { supplierName: "POINT P", docDate: "2026-06-10" },
      [chantier(), chantier({ id: "aff-2", reference: "2026-002", label: "Salle de bain" })],
      buildSupplierHistory([
        { supplierName: "Point P", affaireId: "aff-2" },
        { supplierName: "point p", affaireId: "aff-2" },
        { supplierName: "Point P", affaireId: "aff-1" },
      ]),
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.affaireId).toBe("aff-2");
    expect(result.items[0]?.reasons).toContainEqual({ kind: "historique_fournisseur", count: 2 });
  });

  it("égalité parfaite : on propose les DEUX plutôt que de trancher au hasard", () => {
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-06-10" },
      [chantier(), chantier({ id: "aff-2", reference: "2026-002", label: "Salle de bain" })],
      buildSupplierHistory([
        { supplierName: "Point P", affaireId: "aff-1" },
        { supplierName: "Point P", affaireId: "aff-2" },
      ]),
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items).toHaveLength(2);
  });

  it("l'historique d'un chantier FERMÉ ne ressuscite pas ce chantier", () => {
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-06-10" },
      [chantier({ status: "TERMINEE" }), chantier({ id: "aff-2", reference: "2026-002" })],
      buildSupplierHistory([{ supplierName: "Point P", affaireId: "aff-1" }]),
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    // Seul aff-2 est ouvert : la suggestion tombe sur lui, pas sur l'historique.
    expect(result.items[0]?.affaireId).toBe("aff-2");
    expect(result.items[0]?.reasons).not.toContainEqual(
      expect.objectContaining({ kind: "historique_fournisseur" }),
    );
  });
});

describe("période", () => {
  it("une seule affaire couvre la date : elle est proposée, motif à l'appui", () => {
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-06-10" },
      [
        chantier(),
        chantier({
          id: "aff-2",
          reference: "2026-002",
          startDate: "2026-09-01",
          plannedEndDate: "2026-10-01",
        }),
      ],
      [],
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.affaireId).toBe("aff-1");
    expect(result.items[0]?.reasons).toContainEqual({ kind: "dans_la_periode" });
  });

  it("tolérance de quinze jours : le fournisseur qui facture en fin de mois compte encore", () => {
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-08-10" },
      [
        chantier(),
        chantier({ id: "aff-2", startDate: "2026-11-01", plannedEndDate: "2026-12-01" }),
      ],
      [],
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items[0]?.affaireId).toBe("aff-1");
  });

  it("une affaire SANS aucune date ne prétend pas couvrir la période", () => {
    const result = suggestAffaires(
      { supplierName: "Point P", docDate: "2026-06-10" },
      [
        chantier({ startDate: null, plannedEndDate: null }),
        chantier({ id: "aff-2", reference: "2026-002" }),
      ],
      [],
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items[0]?.affaireId).toBe("aff-2");
  });
});

describe("affaire unique — signal faible, dit comme tel", () => {
  it("une seule affaire ouverte et rien qui la contredise : proposée, motif explicite", () => {
    // Fournisseur inconnu, affaire SANS dates : rien ne contredit.
    const result = suggestAffaires(
      { supplierName: "Fournisseur inconnu", docDate: "2026-06-10" },
      [chantier({ startDate: null, plannedEndDate: null })],
      [],
    );
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items[0]?.reasons).toEqual([{ kind: "seule_affaire_en_cours" }]);
  });

  it("une seule affaire ouverte mais la DATE la contredit : abstention", () => {
    // Le nombre d'affaires ouvertes ne change pas ce qu'une date dit. Proposer
    // un chantier de 2026 pour une facture de 2020 parce qu'il est seul, c'est
    // faire d'une absence de concurrence une preuve.
    const result = suggestAffaires(
      { supplierName: "Inconnu", docDate: "2020-01-01" },
      [chantier()],
      [],
    );
    if (result.kind !== "abstention") throw new Error("cas attendu");
    expect(result.why).toBe("aucun_signal");
  });

  it("une date ILLISIBLE ne vaut pas une contradiction", () => {
    // L'extraction ne valide pas le format : « 12 juin » arrive tel quel. On
    // traite ça comme une date absente, pas comme une date hors période.
    const result = suggestAffaires({ supplierName: "Inconnu", docDate: "12 juin 2026" }, [chantier()], []);
    if (result.kind !== "suggestions") throw new Error("cas attendu");
    expect(result.items[0]?.reasons).toEqual([{ kind: "seule_affaire_en_cours" }]);
  });

  it("ce signal ne sert JAMAIS à départager plusieurs affaires", () => {
    const result = suggestAffaires(
      { supplierName: "Inconnu", docDate: "2020-01-01" },
      [chantier(), chantier({ id: "aff-2" })],
      [],
    );
    expect(result.kind).toBe("abstention");
  });
});

describe("historique dérivé", () => {
  it("regroupe sur le fournisseur NORMALISÉ, pas sur l'orthographe", () => {
    const history = buildSupplierHistory([
      { supplierName: "Point P", affaireId: "aff-1" },
      { supplierName: "POINT P ", affaireId: "aff-1" },
      { supplierName: "point-p", affaireId: "aff-1" },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]?.count).toBe(3);
  });

  it("ignore les pièces sans fournisseur, au lieu de les regrouper sous « vide »", () => {
    const history = buildSupplierHistory([
      { supplierName: null, affaireId: "aff-1" },
      { supplierName: "   ", affaireId: "aff-1" },
    ]);
    expect(history).toEqual([]);
  });
});
