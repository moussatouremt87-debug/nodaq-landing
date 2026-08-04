import { describe, expect, it } from "vitest";
import {
  MODULES,
  PENDING_ACTION_CATALOG_VERSION,
  PENDING_ACTION_GROUPS,
  resolvePendingActionGroups,
  retentionVerdict,
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

describe("rétention — une proposition qui dort n'est pas une proposition", () => {
  const jour = 86_400_000;
  const now = new Date("2026-08-04T09:00:00Z");
  const ilYA = (jours: number) => new Date(now.getTime() - jours * jour);

  it("les horizons sont ceux que la doctrine annonce, valeur par valeur", () => {
    /*
     * Assertion VOLONTAIREMENT rigide : « > 0 » aurait été vrai de n'importe
     * quel chiffre, y compris d'un 3650 posé par distraction. C'est une config
     * versionnée datée sourcée — une règle de rétention qui bouge doit se voir
     * en diff, et faire échouer ce test est précisément la façon dont elle se
     * voit. Toute modification ici s'accompagne d'un bump de version et d'une
     * ligne dans `docs/retention-file-validation.md`.
     */
    const horizons = Object.fromEntries(
      PENDING_ACTION_GROUPS.map((group) => [group.id, group.staleAfterDays]),
    );
    expect(horizons).toEqual({
      relances: 30,
      prospection: 30,
      devis: 60,
      avis: 60,
      facturation_electronique: 60,
      ecritures: 90,
      stocks: 90,
      immobilisations: 180,
    });
  });

  it("une action récente n'est pas touchée", () => {
    const verdict = retentionVerdict(
      { type: "send_dunning", status: "pending", lastActivityAt: ilYA(3) },
      now,
    );
    expect(verdict.action).toBe("garder");
  });

  it("une action REPRISE hier survit, si vieille soit-elle", () => {
    /*
     * Le cas que compter l'âge depuis la CRÉATION aurait détruit : une
     * proposition née il y a six mois, dont le dirigeant a retravaillé le
     * brouillon hier (`PATCH .../draft` laisse le statut à `pending`). La
     * rejeter « sans décision » aurait effacé le texte qu'il venait d'écrire.
     */
    const verdict = retentionVerdict(
      { type: "send_dunning", status: "pending", lastActivityAt: ilYA(1) },
      now,
    );
    expect(verdict.action).toBe("garder");
  });

  it("une action EN ATTENTE au-delà de son horizon est rejetée ET réduite", () => {
    /*
     * Réduire SANS rejeter laisserait une action indécidable dans la file :
     * le dirigeant l'ouvrirait pour n'y trouver plus rien à lire. C'est le
     * défaut que F6 a corrigé, sous une autre forme.
     *
     * Et rejeter se justifie sur le fond : approuver une relance calculée sur
     * un impayé vieux de trois mois enverrait une lettre fausse — la facture
     * a pu être payée entre-temps.
     */
    const verdict = retentionVerdict(
      { type: "send_dunning", status: "pending", lastActivityAt: ilYA(60) },
      now,
    );
    expect(verdict.action).toBe("rejeter_et_reduire");
    // Le motif chiffre l'âge ET l'horizon : « périmée » tout court laisserait
    // l'utilisateur sans moyen de vérifier que la règle a été bien appliquée.
    expect(verdict.reason).toBe("sans décision ni reprise depuis 60 jours (horizon : 30)");
  });

  it("l'horizon est une BORNE : la veille garde, le jour même réduit", () => {
    // Un test à 60 jours contre un horizon de 30 passerait aussi bien contre
    // un horizon de 45, de 1, ou contre un « rejette tout ce qui est vieux ».
    // Le seul cas qui distingue vraiment la valeur, c'est sa frontière.
    const veille = retentionVerdict(
      { type: "send_dunning", status: "pending", lastActivityAt: ilYA(29) },
      now,
    );
    const jourJ = retentionVerdict(
      { type: "send_dunning", status: "pending", lastActivityAt: ilYA(30) },
      now,
    );
    expect(veille.action).toBe("garder");
    expect(jourJ.action).toBe("rejeter_et_reduire");
  });

  it("une action DÉCIDÉE finit par être réduite, sans changer de statut", () => {
    // Une décision est une trace : elle ne se réécrit pas. Mais le contenu
    // sur lequel elle portait, lui, n'a plus de raison d'être conservé.
    const verdict = retentionVerdict(
      { type: "send_dunning", status: "executed", lastActivityAt: ilYA(400) },
      now,
    );
    expect(verdict.action).toBe("reduire");
    // Une décidée d'il y a onze mois est encore dans l'exercice : la borne
    // d'un an doit être une vraie borne, pas « vieux = à réduire ».
    expect(
      retentionVerdict(
        { type: "send_dunning", status: "executed", lastActivityAt: ilYA(364) },
        now,
      ).action,
    ).toBe("garder");
  });

  it("un type INCONNU n'est jamais détruit — il est signalé", () => {
    /*
     * Même asymétrie qu'en F6 : on ne détruit pas ce qu'on n'a pas su classer.
     * Un outil livré avant sa ligne de catalogue verrait sinon ses
     * propositions effacées par une règle qui ne le connaît pas.
     */
    const verdict = retentionVerdict(
      { type: "un_outil_de_demain", status: "pending", lastActivityAt: ilYA(9_999) },
      now,
    );
    expect(verdict.action).toBe("signaler");
    expect(verdict.reason).toContain("hors catalogue");
    // Un type inconnu DÉCIDÉ n'est pas réduit non plus : la borne d'un an ne
    // doit pas devenir la porte dérobée par laquelle on détruit l'inconnu.
    expect(
      retentionVerdict(
        { type: "un_outil_de_demain", status: "executed", lastActivityAt: ilYA(9_999) },
        now,
      ).action,
    ).toBe("signaler");
  });

  it("les horizons sont ORDONNÉS par sensibilité, pas au hasard", () => {
    // Une relance porte un nom et un montant dus ; une immobilisation porte un
    // libellé de compte. La première doit partir plus vite que la seconde.
    const horizon = (id: string) =>
      PENDING_ACTION_GROUPS.find((group) => group.id === id)?.staleAfterDays ?? 0;
    expect(horizon("relances")).toBeLessThan(horizon("immobilisations"));
    expect(horizon("prospection")).toBeLessThan(horizon("immobilisations"));
    /*
     * Et la règle qui a coûté une revue : un dépôt de facture électronique
     * porte l'identité complète du client (raison sociale, adresse, SIRET,
     * libellés) — il ne peut pas dormir plus longtemps qu'une écriture
     * comptable, quand bien même il reste déclarativement valable plus
     * longtemps. Quand les deux critères divergent, le plus court gagne.
     */
    expect(horizon("facturation_electronique")).toBeLessThan(horizon("ecritures"));
  });
});
