/*
 * Fraîcheur des données (ticket 2.21, partie A).
 *
 * LE BUG : l'employé Compta exécutait une action, la base changeait, et
 * l'écran continuait d'afficher les anciens chiffres jusqu'à un rechargement
 * manuel. « Un cockpit qui ment est pire qu'un cockpit vide » — en démo,
 * « attendez, je rafraîchis » détruit la promesse d'un employé virtuel.
 *
 * LE DIAGNOSTIC (les trois causes du ticket, dans l'ordre) :
 *  1. Cache client non invalidé — OUI, mais pas comme annoncé : chaque écran
 *     se rafraîchit déjà après SA propre mutation. Ce qui manquait, c'est le
 *     rafraîchissement quand l'écriture vient d'AILLEURS : l'agent dans le
 *     chat, un autre onglet, un webhook, un collègue.
 *  2. Exécution asynchrone — NON : l'exécution est synchrone dans la requête
 *     d'approbation (`POST /pending-actions/:id/approve` exécute puis répond).
 *     Le 200 arrive donc APRÈS l'écriture métier ; rien à attendre.
 *  3. Agrégats recalculés ailleurs — NON : trésorerie, marge et impayés sont
 *     dérivés À LA LECTURE. Mais ils sont périmés par les mêmes écritures, et
 *     doivent donc figurer dans la correspondance ci-dessous.
 *
 * LA RÈGLE : un écran déclare les ÉVÉNEMENTS qui le salissent ; il n'a jamais
 * à « penser » à se rafraîchir. Ajouter un écran, c'est ajouter une ligne
 * ici — pas relire toutes les mutations du produit.
 */

/** Bump à chaque ajout de vue ou d'événement. */
export const FRESHNESS_RULES_VERSION = "2026-08-02";

/** Vues de données rafraîchissables. */
export const VIEW_KEYS = [
  "cockpit",
  "validation",
  "classeur",
  "tresorerie",
  "impayes",
  "marge",
  "stocks",
  "immobilisations",
  "connecteurs",
  "rh",
  "prospects",
  "avis",
  "factures",
  "echeancier",
  "nav",
] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

/**
 * Événements de domaine émis par le client APRÈS une écriture réussie (ou à
 * la lecture d'un flux SSE qui en signale une). Ils ne portent AUCUNE donnée
 * métier : seulement « quelque chose de cette nature a changé ».
 */
export type DomainEvent =
  | "action.preparee"
  | "action.validee"
  | "action.rejetee"
  | "document.ajoute"
  | "document.rattache"
  | "document.modifie"
  | "fec.importe"
  | "fec.purge"
  | "connecteur.modifie"
  | "module.bascule"
  | "prospect.modifie"
  | "stock.modifie"
  | "rh.modifie"
  | "immobilisation.modifiee"
  | "cout.modifie"
  | "avis.modifie"
  | "echeance.modifiee";

/**
 * Quelles vues chaque événement périme.
 *
 * Les agrégats DÉRIVÉS (trésorerie, impayés, marge) y figurent au même titre
 * que les listes : ils se recalculent à la lecture, donc une écriture les
 * périme aussi. Les oublier laisserait le cockpit afficher un solde d'avant
 * l'action — le bug d'origine, déplacé d'un cran.
 */
export const EVENT_VIEWS: Record<DomainEvent, readonly ViewKey[]> = {
  // Une action préparée n'a encore rien écrit au métier : elle change la file
  // et le compteur du cockpit, rien d'autre.
  "action.preparee": ["cockpit", "validation"],
  // Une action VALIDÉE s'exécute. La liste suit ce que les exécuteurs écrivent
  // RÉELLEMENT (`apps/api/src/executors.ts`) : immobilisation, mouvement de
  // stock, avis client, contact prospect, dépôt de facture électronique — et
  // les agrégats qui s'en dérivent. Le classeur en est absent parce qu'AUCUN
  // exécuteur n'y écrit ; rafraîchir tout à chaque événement, c'est un cockpit
  // qui clignote et des requêtes pour rien.
  "action.validee": [
    "nav",
    "cockpit",
    "validation",
    "tresorerie",
    "impayes",
    "marge",
    "stocks",
    "immobilisations",
    "prospects",
    "avis",
    "factures",
  ],
  "action.rejetee": ["nav", "cockpit", "validation"],
  // `validation` : au-delà du seuil de capitalisation, la pièce photographiée
  // fait naître une proposition d'immobilisation à valider (app.ts, classeur).
  // L'oublier laissait le badge de la nav faux après une photo de facture
  // d'équipement — le bug d'origine, sur le parcours le plus filmé du produit.
  "document.ajoute": ["cockpit", "classeur", "validation"],
  "document.rattache": ["classeur", "tresorerie"],
  // Correction de champs ou suppression d'une pièce. La trésorerie y figure
  // parce que supprimer une pièce RAPPROCHÉE défait le rapprochement : une
  // correction seule périmera la trésorerie pour rien, ce qui coûte une
  // requête — l'oublier coûterait un écran faux.
  "document.modifie": ["cockpit", "classeur", "tresorerie"],
  // Un import FEC remplace les créances dérivées : impayés, marge, cockpit —
  // ET remplit la file, puisqu'il propose jusqu'à 200 immobilisations à
  // valider (comptes 2x/28x). C'est le premier geste d'un nouveau client.
  "fec.importe": ["cockpit", "connecteurs", "impayes", "marge", "tresorerie", "validation"],
  // La purge efface ces mêmes dérivées, mais PAS la file : les propositions
  // déjà déposées survivent à l'effacement des écritures dont elles viennent.
  // D'où deux listes différentes — la nuance est le sujet, pas un détail.
  "fec.purge": ["cockpit", "connecteurs", "impayes", "marge", "tresorerie"],
  "connecteur.modifie": ["cockpit", "connecteurs", "tresorerie", "impayes"],
  // Éteindre un module retire des pages de la NAV et des cartes du cockpit :
  // les deux doivent suivre sans rechargement (pivot ADR-007).
  "module.bascule": ["nav", "cockpit", "connecteurs"],
  "prospect.modifie": ["prospects", "cockpit"],
  // Le cockpit affiche les alertes de stock (quand le module est actif).
  "stock.modifie": ["stocks", "cockpit"],
  // Salariés, absences, synchro paie : la marge en dépend par le coût horaire.
  "rh.modifie": ["rh", "marge"],
  "immobilisation.modifiee": ["immobilisations", "marge"],
  "cout.modifie": ["marge"],
  "avis.modifie": ["avis"],
  // Le cockpit affiche la prochaine échéance fiscale (owner).
  "echeance.modifiee": ["echeancier", "cockpit"],
};

export function viewsFor(event: DomainEvent): readonly ViewKey[] {
  return EVENT_VIEWS[event];
}

/**
 * Outils MCP d'ÉCRITURE → événement de domaine.
 *
 * Le flux SSE du chat ne transporte que des NOMS d'outils (minimisation
 * 2.17/1.6) : c'est exactement ce qu'il faut pour savoir qu'une vue est
 * périmée, sans faire voyager une donnée métier de plus. Un outil de LECTURE
 * ne salit rien et n'a rien à faire ici.
 */
export const WRITE_TOOL_EVENTS: Readonly<Record<string, DomainEvent>> = {
  draft_dunning: "action.preparee",
  ocr_and_book_invoice: "action.preparee",
  draft_quote_from_email: "action.preparee",
  draft_review_reply: "action.preparee",
  draft_prospect_email: "action.preparee",
  adjust_stock: "action.preparee",
};

/** Événement porté par un outil d'écriture, `null` pour une lecture. */
export function eventForTool(toolName: string): DomainEvent | null {
  return WRITE_TOOL_EVENTS[toolName] ?? null;
}

// --- Registre des mutations HTTP -------------------------------------------

/**
 * Effet de chaque helper d'écriture de `lib/api.ts` sur les vues.
 *
 *  - un tableau d'événements POSSIBLES : l'écran qui appelle ce helper DOIT
 *    émettre (lequel dépend parfois du résultat — valider/rejeter) ;
 *  - `"selon_outils"` : l'événement se déduit des outils réellement exécutés
 *    par l'agent (`eventForTool`), pas de l'appel lui-même ;
 *  - `null` : aucune vue PARTAGÉE n'en dépend — l'écran qui écrit est le seul
 *    à afficher la donnée, et il se recharge lui-même.
 *
 * Ce registre est exhaustif par construction : une garde de CI compare ses
 * clés aux helpers mutants de `lib/api.ts`. Ajouter une écriture au produit
 * sans dire ce qu'elle périme fait donc échouer la CI — c'est le seul moyen
 * connu d'empêcher ce correctif de pourrir en six mois.
 */
export type MutationEffect = readonly DomainEvent[] | "selon_outils" | null;

export const MUTATION_EFFECTS: Readonly<Record<string, MutationEffect>> = {
  // File de validation
  updatePendingActionDraft: ["action.preparee"],
  decidePendingAction: ["action.validee", "action.rejetee"],
  // Connecteurs & sources de données
  connectConnector: ["connecteur.modifie"],
  disconnectConnector: ["connecteur.modifie"],
  createWebhookEndpoint: ["connecteur.modifie"],
  deleteWebhookEndpoint: ["connecteur.modifie"],
  importFec: ["fec.importe"],
  syncSilae: ["rh.modifie"],
  // Classeur photo
  uploadClasseurDocument: ["document.ajoute"],
  correctClasseurDocument: ["document.modifie"],
  deleteClasseurDocument: ["document.modifie"],
  matchClasseurDocument: ["document.rattache"],
  // Stocks
  createStockItem: ["stock.modifie"],
  updateStockItem: ["stock.modifie"],
  deleteStockItem: ["stock.modifie"],
  moveStock: ["stock.modifie"],
  // Équipe & plannings
  createStaff: ["rh.modifie"],
  updateStaff: ["rh.modifie"],
  createAbsence: ["rh.modifie"],
  deleteAbsence: ["rh.modifie"],
  // Immobilisations, charges, échéancier
  createFixedAsset: ["immobilisation.modifiee"],
  updateFixedAsset: ["immobilisation.modifiee"],
  putCost: ["cout.modifie"],
  putFiscalProfile: ["echeance.modifiee"],
  putTaxDeadline: ["echeance.modifiee"],
  // Prospection
  createProspect: ["prospect.modifie"],
  updateProspect: ["prospect.modifie"],
  logProspectInteraction: ["prospect.modifie"],
  opposeProspect: ["prospect.modifie"],
  deleteProspect: ["prospect.modifie"],
  // Avis clients
  createReview: ["avis.modifie"],
  importReviews: ["avis.modifie"],
  deleteReview: ["avis.modifie"],
  // Ces trois-là n'écrivent PAS le métier : ils déposent une action à valider.
  // C'est la file (et le badge de la nav) qu'ils périment, pas leur page.
  draftReviewReply: ["action.preparee"],
  draftQuoteFromEmail: ["action.preparee"],
  proposeEReporting: ["action.preparee"],
  // Modules (pivot ADR-007)
  setModule: ["module.bascule"],
  // Le cockpit conversationnel passe par la MÊME boucle que le chat : il peut
  // préparer une action. Ce qu'il périme dépend des outils exécutés.
  askCockpit: "selon_outils",
  // --- N'affectent aucune vue partagée ------------------------------------
  // Appareils de notification : réglage personnel, affiché sur sa seule page.
  registerPushDevice: null,
  updatePushDevice: null,
  revokePushDevice: null,
  // Registre RGPD et profil de veille : lus par leur page uniquement.
  addActivityFromTemplate: null,
  deleteActivity: null,
  putComplianceProfile: null,
  // Back-office support (schéma `ops`, 2.18) : hors des vues d'un tenant.
  updateSupportDraft: null,
  sendSupportReply: null,
  resolveSupportTicket: null,
  validateSupportIssue: null,
};

// --- Bus d'invalidation -----------------------------------------------------

type Listener = () => void;

const listeners = new Map<ViewKey, Set<Listener>>();

/** Abonne un écran à une vue. Rend la fonction de désabonnement. */
export function subscribeView(view: ViewKey, listener: Listener): () => void {
  const set = listeners.get(view) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(view, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(view);
  };
}

/**
 * Signale qu'un événement de domaine a eu lieu : toutes les vues qu'il périme
 * se rafraîchissent.
 *
 * L'échec d'un abonné n'arrête pas les autres : un écran qui jette pendant
 * son refetch recréerait, pour tous les autres, le bug qu'on corrige.
 */
export function emitDomainEvent(event: DomainEvent): void {
  for (const view of viewsFor(event)) {
    for (const listener of listeners.get(view) ?? []) {
      try {
        listener();
      } catch {
        /* un écran cassé ne périme pas les autres */
      }
    }
  }
}

// --- Horodatage « à jour il y a X » -----------------------------------------

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Âge lisible d'une donnée. PURE.
 *
 * `null` (jamais chargé) est DIT : laisser un écran muet ferait passer une
 * absence de données pour des données fraîches. Une horloge client en avance
 * est ramenée à « à l'instant » — « il y a −4 min » ferait douter de tout
 * l'écran pour un décalage qui n'est pas dans les données.
 */
export function formatFreshness(atMs: number | null, nowMs: number): string {
  if (atMs === null) return "jamais rafraîchi";
  const age = Math.max(0, nowMs - atMs);
  if (age < MINUTE) return "à jour à l'instant";
  if (age < HOUR) return `à jour il y a ${Math.floor(age / MINUTE)} min`;
  if (age < DAY) return `à jour il y a ${Math.floor(age / HOUR)} h`;
  return `à jour il y a ${Math.floor(age / DAY)} j`;
}

/** Donnée trop vieille pour être présentée sans réserve (`null` = périmée). */
export function isStale(atMs: number | null, nowMs: number, maxAgeMs: number): boolean {
  if (atMs === null) return true;
  return Math.max(0, nowMs - atMs) > maxAgeMs;
}

// --- Garde de concurrence ---------------------------------------------------

/**
 * Sérialise les chargements concurrents d'un même écran.
 *
 * Le bus, le retour de focus et le bouton « rafraîchir » peuvent lancer trois
 * chargements en même temps. Sans garde, leurs réponses arrivent dans le
 * désordre : l'écran retombe sur des données PLUS ANCIENNES et se déclare
 * « à jour à l'instant » — le cockpit qui ment, reconstitué par le correctif
 * censé le corriger.
 *
 * Seul le chargement le plus récent a le droit d'écrire : les précédents sont
 * ignorés, succès comme échec.
 */
export function createLoadGuard(): {
  run: (load: () => Promise<unknown>) => Promise<"a-jour" | "perime" | "echec">;
} {
  let generation = 0;
  return {
    run: async (load) => {
      const mine = ++generation;
      try {
        await load();
      } catch {
        return mine === generation ? "echec" : "perime";
      }
      // Un chargement dépassé n'a pas le droit de rajeunir l'horodatage.
      return mine === generation ? "a-jour" : "perime";
    },
  };
}

// --- Réveil au retour -------------------------------------------------------

interface EventTargetLike {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Rafraîchit au RETOUR : reprise de focus et reconnexion réseau.
 *
 * L'artisan verrouille son téléphone et revient dix minutes plus tard ; ou il
 * passe sous un tunnel. Sans ça, l'écran affiche l'état d'il y a dix minutes
 * sans le dire. `hidden` est injectable pour que ce soit testable hors DOM.
 */
export function watchFreshness(
  target: EventTargetLike,
  onWake: () => void,
  hidden: () => boolean = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  networkTarget: EventTargetLike = target,
): () => void {
  const onVisible = (): void => {
    // Le réveil, c'est le RETOUR : un onglet qu'on masque n'a rien à refetch.
    if (!hidden()) onWake();
  };
  // `visibilitychange` est émis sur `document` et REMONTE jusqu'à `window` :
  // écouter les deux, c'est deux rechargements complets à chaque alt-tab —
  // soit une vingtaine de requêtes serveur pour un simple retour d'onglet.
  // D'où deux cibles distinctes, et un seul abonnement par type.
  target.addEventListener("visibilitychange", onVisible);
  networkTarget.addEventListener("online", onWake);
  return () => {
    target.removeEventListener("visibilitychange", onVisible);
    networkTarget.removeEventListener("online", onWake);
  };
}
