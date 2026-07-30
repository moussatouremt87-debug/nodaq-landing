import { describe, expect, it } from "vitest";
import {
  matchRegulatoryItems,
  REGULATORY_ITEMS,
  REGULATORY_WATCH_VERSION,
} from "../src/regulatoryWatch.js";

/*
 * Veille réglementaire (ticket 3.7) — catalogue en CONFIG VERSIONNÉE DATÉE
 * sourcée (même doctrine que frenchTax.ts, ADR 2.19) + moteur PUR
 * d'applicabilité : vertical métier + effectif → obligations applicables,
 * chaque inclusion justifiée, jamais un droit inventé. Information générale,
 * PAS un conseil juridique — le label le dit en permanence.
 */

const NOW = new Date("2026-07-30T12:00:00Z");

describe("catalogue réglementaire", () => {
  it("versionné, daté, et CHAQUE entrée porte sa source (traçabilité)", () => {
    expect(REGULATORY_WATCH_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(REGULATORY_ITEMS.length).toBeGreaterThanOrEqual(8);
    for (const item of REGULATORY_ITEMS) {
      expect(item.id).toBeTruthy();
      expect(item.obligation.length).toBeGreaterThan(20);
      expect(item.source.label).toBeTruthy();
      expect(item.source.url).toMatch(/^https:\/\//);
    }
  });
});

describe("matchRegulatoryItems", () => {
  it("seuils d'effectif : inclus au seuil atteint, exclu en dessous, raison chiffrée", () => {
    const small = matchRegulatoryItems({ vertical: "services", headcount: 8 }, NOW);
    const big = matchRegulatoryItems({ vertical: "services", headcount: 60 }, NOW);
    // CSE : seuil 11 salariés.
    expect(small.matches.some((m) => m.id === "cse")).toBe(false);
    const cse = big.matches.find((m) => m.id === "cse");
    expect(cse?.applies).toBe("oui");
    expect(cse?.reason).toContain("60");
    // Index égalité : seuil 50 — présent à 60, absent à 8.
    expect(big.matches.some((m) => m.id === "index-egalite")).toBe(true);
    expect(small.matches.some((m) => m.id === "index-egalite")).toBe(false);
  });

  it("effectif inconnu : les obligations à seuil restent visibles en « peut_etre », jamais tues", () => {
    const result = matchRegulatoryItems({ vertical: "retail", headcount: null }, NOW);
    const cse = result.matches.find((m) => m.id === "cse");
    expect(cse?.applies).toBe("peut_etre");
    expect(cse?.reason).toContain("effectif non renseigné");
  });

  it("effectif ESTIMÉ depuis l'équipe : sous le seuil = « peut_etre », jamais une exclusion silencieuse", () => {
    // 3 fiches actives seulement (saisie RH partielle) : CSE et OETH restent
    // visibles « à confirmer » — l'estimation ne peut pas taire une obligation.
    const estimated = matchRegulatoryItems(
      { vertical: "services", headcount: 3, headcountSource: "equipe" },
      NOW,
    );
    const cse = estimated.matches.find((m) => m.id === "cse");
    expect(cse?.applies).toBe("peut_etre");
    expect(cse?.reason).toContain("saisie RH possiblement partielle");
    // Le même chiffre DÉCLARÉ par l'owner exclut réellement.
    const declared = matchRegulatoryItems(
      { vertical: "services", headcount: 3, headcountSource: "declare" },
      NOW,
    );
    expect(declared.matches.some((m) => m.id === "cse")).toBe(false);
    // Et la source du chiffre est TOUJOURS dite dans la raison.
    const big = matchRegulatoryItems(
      { vertical: "services", headcount: 20, headcountSource: "equipe" },
      NOW,
    );
    expect(big.matches.find((m) => m.id === "cse")?.reason).toContain("estimé depuis l'équipe");
  });

  it("médiation de la consommation : tous verticals (le BTP chez les particuliers est concerné)", () => {
    const btp = matchRegulatoryItems({ vertical: "industrie_btp", headcount: 5 }, NOW);
    expect(btp.matches.some((m) => m.id === "mediation-consommation")).toBe(true);
  });

  it("verticals : la décennale ne s'applique qu'au BTP, l'affichage des prix au retail", () => {
    const btp = matchRegulatoryItems({ vertical: "industrie_btp", headcount: 5 }, NOW);
    const services = matchRegulatoryItems({ vertical: "services", headcount: 5 }, NOW);
    expect(btp.matches.some((m) => m.id === "garantie-decennale")).toBe(true);
    expect(services.matches.some((m) => m.id === "garantie-decennale")).toBe(false);
    const retail = matchRegulatoryItems({ vertical: "retail", headcount: 5 }, NOW);
    expect(retail.matches.some((m) => m.id === "information-prix")).toBe(true);
  });

  it("échéances : facturation électronique = échéance proche (réception 2026-09-01), statut daté", () => {
    const result = matchRegulatoryItems({ vertical: "services", headcount: 5 }, NOW);
    const reception = result.matches.find((m) => m.id === "facture-electronique-reception");
    expect(reception?.status).toBe("echeance_proche"); // 33 jours au 2026-07-30
    expect(reception?.daysUntil).toBe(33);
    // Émission PME : 2027-09-01, encore loin -> à venir.
    const emission = result.matches.find((m) => m.id === "facture-electronique-emission");
    expect(emission?.status).toBe("a_venir");
    // Obligations permanentes -> en vigueur, sans échéance.
    const rgpd = result.matches.find((m) => m.id === "rgpd-registre");
    expect(rgpd?.status).toBe("en_vigueur");
    expect(rgpd?.daysUntil).toBeNull();
  });

  it("échéance récurrente : l'index égalité pointe la PROCHAINE occurrence (1er mars)", () => {
    const result = matchRegulatoryItems({ vertical: "services", headcount: 80 }, NOW);
    const index = result.matches.find((m) => m.id === "index-egalite");
    expect(index?.nextDeadline).toBe("2027-03-01");
    expect(index?.status).toBe("a_venir");
  });

  it("tri : échéances proches d'abord (par urgence), puis à venir, puis en vigueur", () => {
    const result = matchRegulatoryItems({ vertical: "services", headcount: 60 }, NOW);
    const statuses = result.matches.map((m) => m.status);
    const order = { echeance_proche: 0, a_venir: 1, en_vigueur: 2 };
    const ranks = statuses.map((s) => order[s]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("sortie labellisée information générale + version du catalogue", () => {
    const result = matchRegulatoryItems({ vertical: "autre", headcount: null }, NOW);
    expect(result.version).toBe(REGULATORY_WATCH_VERSION);
    expect(result.label).toContain("information générale");
    expect(result.label).toContain("conseil juridique");
    // Vertical « autre » : uniquement les obligations transverses.
    for (const match of result.matches) {
      expect(match.verticals ?? null).toBeNull();
    }
  });
});
