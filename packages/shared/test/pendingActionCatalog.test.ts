import { describe, expect, it } from "vitest";
import {
  MODULES,
  PENDING_ACTION_CATALOG_VERSION,
  PENDING_ACTION_GROUPS,
  moduleOfPendingAction,
  resolvePendingActionGroups,
} from "../src/index.js";

/*
 * F6 — la file de validation recentrée sur le socle.
 *
 * Deux questions à chaque cas : « ce groupe a-t-il le droit d'exister » et
 * surtout « une action peut-elle disparaître ». La seconde commande tout : une
 * action masquée est une décision que personne ne prendra jamais.
 */

describe("config versionnée", () => {
  it("porte une version datée", () => {
    expect(PENDING_ACTION_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });

  it("chaque groupe cite un module qui EXISTE, ou le socle", () => {
    // Un identifiant de module fantôme rendrait le groupe éteint pour
    // toujours : il ne serait jamais dans la liste des modules actifs.
    const ids = new Set(MODULES.map((module) => module.id));
    for (const group of PENDING_ACTION_GROUPS) {
      if (group.module !== null) expect(ids.has(group.module)).toBe(true);
    }
  });

  it("aucun type n'est réclamé par deux groupes", () => {
    const seen = new Set<string>();
    for (const group of PENDING_ACTION_GROUPS) {
      for (const type of group.types) {
        expect(seen.has(type)).toBe(false);
        seen.add(type);
      }
    }
  });
});

describe("un type inconnu n'est pas un type caché", () => {
  it("un outil ajouté demain sort en socle, jamais masqué", () => {
    // Le défaut penche du côté visible : un outil livré avant sa ligne de
    // catalogue doit rester décidable, quitte à être mal rangé.
    expect(moduleOfPendingAction("un_outil_de_demain")).toBeNull();
  });

  it("un type inconnu produit quand même un groupe visible", () => {
    const groups = resolvePendingActionGroups(["un_outil_de_demain"], []);
    expect(groups.some((group) => group.count === 1)).toBe(true);
  });
});

describe("les groupes suivent le registre 3.11", () => {
  it("un module éteint SANS action en attente ne montre pas d'onglet", () => {
    const groups = resolvePendingActionGroups(["send_dunning"], ["avis"]);
    expect(groups.some((group) => group.id === "avis")).toBe(false);
  });

  it("un groupe sans action ne montre pas d'onglet, module allumé ou non", () => {
    // Un onglet à zéro est du bruit : on ne l'affiche pas.
    const groups = resolvePendingActionGroups([], []);
    expect(groups).toHaveLength(0);
  });
});

describe("ce qui ne doit JAMAIS arriver : une action qui disparaît", () => {
  it("un module éteint AVEC des actions en attente garde son onglet", () => {
    // Une action préparée avant l'extinction reste une décision à prendre.
    // La masquer la bloquerait pour toujours, sans un mot — et le compteur de
    // la nav continuerait de la compter.
    const groups = resolvePendingActionGroups(["record_review_reply"], ["avis"]);
    const avis = groups.find((group) => group.module === "avis");
    expect(avis).toBeDefined();
    expect(avis?.count).toBe(1);
  });

  it("et il DIT que le module est éteint", () => {
    // « Ce module est éteint » explique pourquoi la page correspondante a
    // disparu de la nav alors que l'action, elle, est toujours là.
    const groups = resolvePendingActionGroups(["record_review_reply"], ["avis"]);
    expect(groups.find((group) => group.module === "avis")?.moduleOff).toBe(true);
  });

  it("le total des groupes couvre TOUTES les actions en attente", () => {
    // L'invariant qui compte : la somme des onglets égale la file. Un type
    // oublié du catalogue ne doit pas s'évaporer entre deux compteurs.
    const pending = [
      "send_dunning",
      "send_dunning",
      "create_quote",
      "record_review_reply",
      "submit_einvoice",
      "create_fixed_asset",
      "adjust_stock",
      "record_prospect_contact",
      "book_invoice",
      "submit_reconciliation",
      "report_einvoice_transactions",
      "type_jamais_vu",
    ];
    const groups = resolvePendingActionGroups(pending, ["avis", "stocks", "immobilisations"]);
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(pending.length);
  });
});
