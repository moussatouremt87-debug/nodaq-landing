import { describe, expect, it } from "vitest";
import {
  buildProspectionPlan,
  FOLLOWUP_AFTER_DAYS,
  PROSPECT_SOURCES,
  PROSPECTION_RULES_VERSION,
  RETENTION_DAYS,
  RETENTION_MONTHS,
} from "../src/prospection.js";
import type { InteractionRecord, ProspectRecord } from "../src/prospection.js";

/*
 * CRM & prospection (2.12). Premier ticket qui stocke des données de personnes
 * qui ne sont PAS clientes : ce qui est testé ici, c'est la légitimité de la
 * détention — provenance, opposition, rétention — avant l'utilité commerciale.
 */

const NOW = new Date("2026-07-31T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function prospect(overrides: Partial<ProspectRecord> = {}): ProspectRecord {
  return {
    id: "p1",
    name: "Mme Roussel",
    company: "Roussel Bâtiment",
    stage: "contacte",
    source: "salon",
    optedOut: false,
    createdAt: daysAgo(60),
    ...overrides,
  };
}

function interaction(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return { prospectId: "p1", kind: "appel", occurredAt: daysAgo(3), ...overrides };
}

describe("config", () => {
  it("règles versionnées et datées", () => {
    expect(PROSPECTION_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FOLLOWUP_AFTER_DAYS.contacte).toBeGreaterThan(0);
    expect(RETENTION_MONTHS).toBe(36);
  });

  it("l'achat de fichier n'est PAS une provenance proposée", () => {
    // Sa licéité se juge fichier par fichier : le produit ne la prend pas en
    // charge plutôt que de la légitimer par une case à cocher.
    expect(PROSPECT_SOURCES).not.toContain("achat_fichier");
    expect(PROSPECT_SOURCES.length).toBeGreaterThan(0);
  });
});

describe("opposition (art. 21) — une exclusion, pas un filtre", () => {
  it("un prospect opposé n'apparaît dans AUCUNE liste, même très en retard", () => {
    const plan = buildProspectionPlan(
      [prospect({ optedOut: true, createdAt: daysAgo(400) })],
      [],
      NOW,
    );
    expect(plan.followups).toEqual([]);
    expect(plan.retentionAlerts).toEqual([]);
    // Il ne compte pas non plus dans le pipeline : ce n'est plus une affaire.
    expect(Object.values(plan.pipeline).every((count) => count === 0)).toBe(true);
    // Mais l'exclusion est PROUVÉE par un compteur.
    expect(plan.optedOutCount).toBe(1);
  });

  it("l'opposé n'est jamais nommé dans le plan", () => {
    const plan = buildProspectionPlan(
      [prospect({ id: "p9", name: "Jean Opposé", optedOut: true, createdAt: daysAgo(400) })],
      [interaction({ prospectId: "p9", occurredAt: daysAgo(300) })],
      NOW,
    );
    expect(JSON.stringify(plan)).not.toContain("Jean Opposé");
    expect(JSON.stringify(plan)).not.toContain("p9");
  });
});

describe("relance = un délai écoulé, jamais une intention supposée", () => {
  it("contact récent : rien à relancer", () => {
    const plan = buildProspectionPlan([prospect()], [interaction({ occurredAt: daysAgo(3) })], NOW);
    expect(plan.followups).toEqual([]);
    expect(plan.pipeline.contacte).toBe(1);
  });

  it("au-delà du seuil de l'étape : à relancer, avec les jours ET le seuil", () => {
    const plan = buildProspectionPlan([prospect()], [interaction({ occurredAt: daysAgo(30) })], NOW);
    const [followup] = plan.followups;
    expect(followup?.verdict).toBe("a_relancer");
    expect(followup?.daysSinceContact).toBe(30);
    expect(followup?.thresholdDays).toBe(FOLLOWUP_AFTER_DAYS.contacte);
    expect(followup?.reason).toContain("30 jour(s)");
    expect(followup?.reason).toContain("seuil");
  });

  it("jamais contacté : distingué d'une relance, compté depuis la CRÉATION", () => {
    const plan = buildProspectionPlan([prospect({ createdAt: daysAgo(45) })], [], NOW);
    const [followup] = plan.followups;
    expect(followup?.verdict).toBe("jamais_contacte");
    expect(followup?.lastContactAt).toBeNull();
    expect(followup?.daysSinceContact).toBe(45);
    expect(followup?.reason).toContain("AUCUN contact");
  });

  it("étapes terminales : un dossier gagné ou perdu ne se relance pas", () => {
    const plan = buildProspectionPlan(
      [
        prospect({ id: "g", stage: "gagne", createdAt: daysAgo(400) }),
        prospect({ id: "p", stage: "perdu", createdAt: daysAgo(400) }),
      ],
      [],
      NOW,
    );
    expect(plan.followups).toEqual([]);
    expect(plan.pipeline.gagne).toBe(1);
    expect(plan.pipeline.perdu).toBe(1);
  });

  it("le dernier contact est DÉRIVÉ du journal : le plus récent gagne", () => {
    // Rien n'est stocké : un champ « dernier contact » modifiable ment tôt ou
    // tard, et personne ne s'en aperçoit.
    const plan = buildProspectionPlan(
      [prospect()],
      [
        interaction({ occurredAt: daysAgo(40) }),
        interaction({ occurredAt: daysAgo(2), kind: "email" }),
        interaction({ occurredAt: daysAgo(90) }),
      ],
      NOW,
    );
    expect(plan.followups).toEqual([]);
  });

  it("le plus ancien contact remonte en tête : c'est celui qu'on perd", () => {
    const plan = buildProspectionPlan(
      [
        prospect({ id: "recent", createdAt: daysAgo(20) }),
        prospect({ id: "ancien", createdAt: daysAgo(200) }),
      ],
      [],
      NOW,
    );
    expect(plan.followups.map((f) => f.id)).toEqual(["ancien", "recent"]);
  });
});

describe("rétention — garder sans le dire est une faute", () => {
  it("au-delà de la durée de conservation : la fiche est SIGNALÉE, par son id seul", () => {
    const plan = buildProspectionPlan(
      [prospect({ id: "vieux", name: "Nom Périmé", createdAt: daysAgo(RETENTION_DAYS + 10) })],
      [],
      NOW,
    );
    expect(plan.retentionAlerts.map((alert) => alert.id)).toEqual(["vieux"]);
    // Seul endroit du plan où une personne serait nommée à côté d'un verdict
    // de suppression : l'écran a déjà les noms, le plan n'en a pas besoin.
    expect(JSON.stringify(plan.retentionAlerts)).not.toContain("Nom Périmé");
  });

  it("une fiche OPPOSÉE périmée est comptée : sortir du pipeline ne vaut pas droit d'être gardé pour toujours", () => {
    // Sans ce compteur, l'opposé était conservé indéfiniment SANS jamais être
    // signalé — l'exact contraire de « ne jamais garder sans le dire ».
    const fiche = prospect({ optedOut: true, createdAt: daysAgo(RETENTION_DAYS + 10) });
    const plan = buildProspectionPlan([fiche], [], NOW);
    expect(plan.expiredOptedOutCount).toBe(1);
    /*
     * Et on peut dire LAQUELLE. La version d'origine ne rendait qu'un compte,
     * en faisant valoir que nommer un opposé contredirait son exclusion — vrai
     * des NOMS, faux des identifiants. Le compte seul ne résolvait qu'à moitié
     * le problème qu'il énonce : « 3 fiches opposées sont périmées » sans
     * moyen de dire lesquelles n'est pas un signalement, c'est une inquiétude.
     */
    expect(plan.expiredOptedOut).toHaveLength(1);
    // L'identifiant RÉEL, pas une place vide : c'est lui qui permet à l'écran
    // de marquer la bonne ligne. Sans cette assertion, un `id: ""` passait.
    expect(plan.expiredOptedOut[0]?.id).toBe(fiche.id);
    expect(plan.expiredOptedOut[0]?.daysSinceContact).toBeGreaterThan(1_080);
    // Toujours AUCUN nom : c'est la moitié de la décision d'origine qui tient.
    expect(JSON.stringify(plan.expiredOptedOut)).not.toContain("name");
    expect(plan.retentionAlerts).toEqual([]);
  });

  it("un contact récent relance la durée : pas d'alerte sur un dossier vivant", () => {
    const plan = buildProspectionPlan(
      [prospect({ createdAt: daysAgo(2_000) })],
      [interaction({ occurredAt: daysAgo(5) })],
      NOW,
    );
    expect(plan.retentionAlerts).toEqual([]);
  });

  it("le produit SIGNALE, il ne purge pas : le plan n'efface rien", () => {
    const prospects = [prospect({ createdAt: daysAgo(3_000) })];
    const plan = buildProspectionPlan(prospects, [], NOW);
    expect(plan.retentionAlerts).toHaveLength(1);
    // L'entrée fournie est intacte : aucune suppression implicite.
    expect(prospects).toHaveLength(1);
  });
});

describe("invariants", () => {
  it("fiche illisible : comptée, jamais devinée", () => {
    const plan = buildProspectionPlan([prospect({ createdAt: "pas une date" })], [], NOW);
    expect(plan.unusableCount).toBe(1);
    expect(plan.followups).toEqual([]);
  });

  it("MINIMISATION : ni e-mail, ni téléphone, ni notes n'entrent dans le plan", () => {
    // Décider QUI relancer ne demande pas de savoir comment le joindre. Le
    // modèle pur ne reçoit même pas ces champs : la minimisation est
    // structurelle, pas une consigne de prompt.
    const plan = buildProspectionPlan(
      [prospect({ createdAt: daysAgo(90) })],
      [interaction({ occurredAt: daysAgo(80) })],
      NOW,
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toMatch(/email|phone|telephone|notes/i);
    expect(serialized).not.toContain("@");
  });

  it("label PERMANENT : un délai écoulé, et l'opposition rappelée", () => {
    const plan = buildProspectionPlan([], [], NOW);
    expect(plan.label).toContain("délai écoulé");
    expect(plan.label).toContain("opposé");
  });

  it("PURE : deux appels identiques donnent le même plan", () => {
    const prospects = [prospect(), prospect({ id: "p2", createdAt: daysAgo(100) })];
    const journal = [interaction({ occurredAt: daysAgo(50) })];
    expect(buildProspectionPlan(prospects, journal, NOW)).toEqual(
      buildProspectionPlan(prospects, journal, NOW),
    );
  });
});
