/*
 * Catalogue des actions à valider (F6) — CONFIG VERSIONNÉE DATÉE, même
 * doctrine que `moduleCatalog.ts` (3.11) dont il est le pendant : 3.11 dit
 * quels modules existent, celui-ci dit à quel module se rattache chaque type
 * d'action de la file de validation.
 *
 * POURQUOI CE FICHIER EXISTE. La file listait ses onglets en dur, dans l'écran.
 * Deux conséquences, toutes deux visibles depuis le pivot (ADR-007) :
 *
 * 1. La liste avait cessé d'être vraie. Cinq types d'action sur dix n'avaient
 *    aucun onglet (`record_prospect_contact`, `submit_einvoice`,
 *    `report_einvoice_transactions`, `create_fixed_asset`, `adjust_stock`) :
 *    ces actions n'existaient que dans « Toutes », introuvables dès que la file
 *    dépassait un écran.
 * 2. Un onglet « Avis » subsistait alors que le module `avis` est hors socle
 *    depuis le pivot — un filtre vers un module dont la page a disparu.
 *
 * LA RÈGLE QUI COMMANDE TOUT LE RESTE : **une action en attente n'est JAMAIS
 * masquée.** Le registre 3.11 gouverne les ONGLETS, pas les actions. Une action
 * préparée avant l'extinction de son module reste une décision à prendre ; la
 * cacher la bloquerait pour toujours, sans un mot, pendant que le compteur de
 * la navigation continuerait de la compter. Éteindre un module retire une
 * surface produit, ça n'annule pas un engagement déjà pris.
 */

import { MODULES } from "./moduleCatalog.js";

/** Date d'instantané — à bumper à chaque changement de groupe ou de type. */
export const PENDING_ACTION_CATALOG_VERSION = "2026-08-04";

export interface PendingActionGroup {
  /** Identifiant d'onglet, stable (utilisé comme clé d'UI). */
  readonly id: string;
  /** Français, prêt à afficher. */
  readonly label: string;
  readonly types: readonly string[];
  /**
   * Module 3.11 qui porte ce groupe. `null` = SOCLE : la file de validation
   * elle-même n'est pas un module (elle fait partie du cœur), et les relances,
   * devis et écritures ne dépendent d'aucun module activable.
   */
  readonly module: string | null;
  /**
   * Au-delà de ce délai SANS AUCUNE ACTIVITÉ, la proposition est rejetée et
   * réduite. « Activité » = la dernière trace humaine sur la ligne (création,
   * modification du brouillon, rattachement à un chantier, décision), pas la
   * seule création : une proposition retravaillée hier est vivante, quelle que
   * soit sa date de naissance.
   *
   * Les valeurs ne sont pas rondes par hasard : elles suivent la vitesse à
   * laquelle le CONTENU devient faux, pas une préférence esthétique. Une
   * relance calculée sur un impayé d'il y a deux mois propose d'écrire à
   * quelqu'un qui a peut-être payé ; une proposition d'immobilisation, elle,
   * reste exacte des mois durant — son montant ne bouge pas.
   *
   * Second critère : ce que le payload porte de PERSONNEL. Attention, les deux
   * critères ne vont PAS toujours dans le même sens — un dépôt de facture
   * électronique reste valable longtemps ET porte l'identité complète du
   * client. Quand ils divergent, c'est le plus court qui gagne.
   */
  readonly staleAfterDays: number;
}

/**
 * Les groupes d'onglets, dans leur ordre d'affichage.
 *
 * L'ordre est FIXE : la file est lue tous les jours, et un ordre qui bouge d'un
 * chargement à l'autre donne l'impression que quelque chose a changé. Le socle
 * d'abord (ce qui touche l'argent qui rentre et sort), les modules ensuite.
 */
export const PENDING_ACTION_GROUPS: readonly PendingActionGroup[] = [
  {
    id: "relances",
    label: "Relances",
    types: ["send_dunning"],
    module: null,
    // Un impayé bouge vite : la facture a pu être réglée entre-temps, et la
    // lettre proposée nomme quelqu'un en lui réclamant de l'argent.
    staleAfterDays: 30,
  },
  {
    id: "devis",
    label: "Devis",
    types: ["create_quote"],
    module: null,
    // Une demande de devis de deux mois est morte commercialement — et c'est
    // le payload le plus riche en PII depuis la dictée (verbatim intégral).
    staleAfterDays: 60,
  },
  {
    id: "ecritures",
    label: "Écritures",
    types: ["submit_reconciliation", "book_invoice"],
    module: null,
    // Comptable : le contenu reste exact longtemps, mais un rapprochement
    // jamais tranché finit par ne plus correspondre au relevé.
    //
    // 90 j et pas plus, parce que ces payloads ne sont PAS anonymes : un
    // `book_invoice` porte le client et le montant, un `submit_reconciliation`
    // les libellés d'écritures bancaires. C'est le contenu qui se périme
    // lentement, pas la sensibilité qui serait faible.
    staleAfterDays: 90,
  },
  {
    id: "prospection",
    label: "Prospection",
    types: ["record_prospect_contact"],
    module: null,
    // Nominatif, et la prospection se périme aussi vite que la relance.
    staleAfterDays: 30,
  },
  {
    id: "stocks",
    label: "Stocks",
    types: ["adjust_stock"],
    module: "stocks",
    // Aucune donnée personnelle ; un ajustement non tranché devient faux dès
    // que le stock réel bouge.
    staleAfterDays: 90,
  },
  {
    id: "immobilisations",
    label: "Immobilisations",
    types: ["create_fixed_asset"],
    module: "immobilisations",
    // Le montant d'une immobilisation ne bouge pas, et le payload ne porte
    // qu'un libellé de compte : rien n'impose de se presser.
    staleAfterDays: 180,
  },
  {
    id: "avis",
    label: "Avis clients",
    types: ["record_review_reply"],
    module: "avis",
    // Répondre à un avis six mois après ne se fait pas ; le texte cite un
    // client.
    staleAfterDays: 60,
  },
  {
    id: "facturation_electronique",
    label: "Factures électroniques",
    types: ["submit_einvoice", "report_einvoice_transactions"],
    module: "facturation_electronique",
    /*
     * 60 j, et c'est le critère PII qui commande — le seul groupe où les deux
     * critères divergent.
     *
     * Un dépôt reste déclarativement valable longtemps (l'obligation ne se
     * périme pas comme un impayé) : sur le seul critère de justesse, 90 j se
     * défendait. Mais `submit_einvoice` porte une facture client COMPLÈTE —
     * raison sociale, adresse, SIRET, libellés de lignes : après le devis
     * dicté, le payload le plus bavard de la file. Lui donner l'horizon des
     * groupes peu nominatifs aurait été justifier le délai le plus long par
     * l'argument le plus faux.
     *
     * `report_einvoice_transactions`, agrégats seulement, aurait pu rester à
     * 90 j ; il partage l'onglet, donc l'horizon. Un e-reporting non déposé au
     * bout de deux mois est de toute façon un problème, pas une proposition.
     */
    staleAfterDays: 60,
  },
];

/** Groupe fourre-tout des types absents du catalogue — visible, jamais masqué. */
const UNCATALOGUED: PendingActionGroup = {
  id: "autres",
  label: "Autres",
  types: [],
  module: null,
  // Jamais atteint par la rétention : un type hors catalogue est SIGNALÉ, pas
  // détruit (voir `retentionVerdict`). La valeur est là pour satisfaire le
  // type, elle ne sert à rien.
  staleAfterDays: Number.POSITIVE_INFINITY,
};

export interface ResolvedPendingActionGroup extends PendingActionGroup {
  /** Actions EN ATTENTE de ce groupe. */
  readonly count: number;
  /**
   * Le module de ce groupe est éteint alors que des actions attendent.
   *
   * L'onglet reste — ces décisions sont toujours dues — mais l'écran le DIT,
   * sinon la présence d'actions d'un module absent de la navigation passe pour
   * un bug.
   */
  readonly moduleOff: boolean;
}

const KNOWN_MODULE_IDS = new Set(MODULES.map((module) => module.id));

/**
 * Onglets à afficher pour une file donnée. PURE.
 *
 * Un groupe sans action n'apparaît pas : un onglet à zéro est du bruit. Un
 * groupe AVEC des actions apparaît toujours, module éteint ou non — voir la
 * règle en tête de fichier.
 *
 * `inactiveModules` = modules effectivement ÉTEINTS pour ce tenant (registre
 * 3.11 résolu). Un identifiant inconnu y est ignoré plutôt que de faire
 * disparaître un onglet sur une faute de frappe.
 */
export function resolvePendingActionGroups(
  pendingTypes: readonly string[],
  inactiveModules: readonly string[],
): readonly ResolvedPendingActionGroup[] {
  const off = new Set(inactiveModules.filter((id) => KNOWN_MODULE_IDS.has(id)));
  const counts = new Map<string, number>();
  for (const type of pendingTypes) counts.set(type, (counts.get(type) ?? 0) + 1);

  const resolved: ResolvedPendingActionGroup[] = [];
  for (const group of PENDING_ACTION_GROUPS) {
    const count = group.types.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
    if (count === 0) continue;
    resolved.push({ ...group, count, moduleOff: group.module !== null && off.has(group.module) });
  }

  // Tout type hors catalogue atterrit ici : la somme des onglets doit égaler la
  // file, sinon une action s'évapore entre deux compteurs.
  const catalogued = new Set(PENDING_ACTION_GROUPS.flatMap((group) => group.types));
  const orphanCount = [...counts.entries()]
    .filter(([type]) => !catalogued.has(type))
    .reduce((sum, [, count]) => sum + count, 0);
  if (orphanCount > 0) {
    resolved.push({ ...UNCATALOGUED, count: orphanCount, moduleOff: false });
  }
  return resolved;
}

// ── Rétention (art. 5.1.e) ──────────────────────────────────────────────────

/**
 * Combien de temps une action DÉCIDÉE garde son contenu.
 *
 * La décision elle-même est une trace définitive — qui a validé quoi, et
 * quand, ne s'efface pas. Ce qui s'efface, c'est ce sur quoi elle portait :
 * le brouillon envoyé, le nom du client, le verbatim d'une dictée. Un an
 * couvre l'exercice comptable, donc toute relecture légitime a eu lieu.
 *
 * La plupart des types sont déjà réduits AU MOMENT de la décision
 * (`reduceFinishedPayload`, `reduceQuotePayload`) : cette borne est le filet
 * pour ceux qui ne le sont pas, et pour l'existant écrit avant ces règles.
 */
export const DECIDED_RETENTION_DAYS = 365;

/** Ce qu'une action porte de pertinent pour la rétention. */
export interface RetentionCandidate {
  readonly type: string;
  readonly status: string;
  /**
   * Dernière ACTIVITÉ sur la ligne, pas sa création.
   *
   * La différence n'est pas cosmétique. Deux routes écrivent en laissant le
   * statut à `pending` : la reprise du brouillon (`PATCH .../draft`) et le
   * rattachement à un chantier (`PATCH .../affaire`). Compter l'âge depuis la
   * création aurait rejeté « sans décision » une proposition retravaillée la
   * veille — et le balayage aurait écrasé le texte que le dirigeant venait
   * d'écrire, en prétendant que personne ne s'en était occupé.
   *
   * Pour une action décidée, c'est ≥ la date de décision : la borne d'un an ne
   * peut donc que se déclencher plus tard, jamais plus tôt.
   */
  readonly lastActivityAt: Date;
}

export type RetentionAction =
  /** Rien à faire. */
  | "garder"
  /** En attente et périmée : rejetée ET réduite — jamais l'un sans l'autre. */
  | "rejeter_et_reduire"
  /** Décidée depuis longtemps : contenu retiré, statut et attribution intacts. */
  | "reduire"
  /** Type hors catalogue : on ne détruit pas ce qu'on n'a pas su classer. */
  | "signaler";

export interface RetentionVerdict {
  readonly action: RetentionAction;
  /** Français, destiné à être écrit dans le payload réduit ou au journal. */
  readonly reason: string;
}

const GROUP_BY_TYPE = new Map<string, PendingActionGroup>(
  PENDING_ACTION_GROUPS.flatMap((group) => group.types.map((type) => [type, group] as const)),
);

const DAY_MS = 86_400_000;

/**
 * Que faire d'une action au regard de la rétention. PURE.
 *
 * DEUX RÈGLES QUI COMMANDENT LE RESTE.
 *
 * 1. **Rejeter et réduire vont ENSEMBLE.** Réduire une action encore en
 *    attente laisserait dans la file une proposition qu'on ne peut plus lire
 *    donc plus décider — le défaut que F6 a corrigé, sous une autre forme. Et
 *    le rejet se justifie sur le fond : approuver une relance calculée sur un
 *    impayé vieux de trois mois enverrait une lettre fausse.
 *
 * 2. **Un type inconnu n'est jamais détruit.** Même asymétrie qu'en F6 : un
 *    outil livré avant sa ligne de catalogue verrait sinon ses propositions
 *    effacées par une règle qui ne le connaît pas. On SIGNALE, quelqu'un
 *    catalogue, et la règle s'applique au tour suivant.
 *
 * L'âge se compte sur `lastActivityAt`, JAMAIS sur la création — voir le
 * commentaire de ce champ : deux routes retravaillent une action en la
 * laissant `pending`, et les compter pour rien reviendrait à effacer le
 * travail d'un humain en l'accusant de ne pas avoir décidé.
 *
 * AUCUNE GARDE « déjà réduite » ici, et c'est délibéré. Une version
 * précédente en portait une, sur un champ que le seul appelant codait à
 * `false` en dur : une branche morte, avec son test, qui donnait l'illusion
 * que l'idempotence du balayage tenait à la règle pure. Elle tient au SQL de
 * lecture (`payload->'reducedAt' IS NULL`) et à lui seul — le dire ici évite
 * qu'on retire un jour le filtre en croyant la règle protégée.
 */
export function retentionVerdict(
  candidate: RetentionCandidate,
  now: Date,
): RetentionVerdict {
  const group = GROUP_BY_TYPE.get(candidate.type);
  if (group === undefined) {
    return {
      action: "signaler",
      reason: `type hors catalogue (${candidate.type}) — à classer avant toute rétention`,
    };
  }
  const ageDays = Math.floor((now.getTime() - candidate.lastActivityAt.getTime()) / DAY_MS);

  if (candidate.status === "pending") {
    if (ageDays < group.staleAfterDays) return { action: "garder", reason: "dans son horizon" };
    return {
      action: "rejeter_et_reduire",
      reason: `sans décision ni reprise depuis ${ageDays} jours (horizon : ${group.staleAfterDays})`,
    };
  }

  if (ageDays < DECIDED_RETENTION_DAYS) return { action: "garder", reason: "dans son horizon" };
  return {
    action: "reduire",
    reason: `décidée il y a ${ageDays} jours — contenu retiré, décision conservée`,
  };
}
