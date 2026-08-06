/*
 * Fraîcheur des données — LE REGISTRE, partagé serveur ET client.
 *
 * POURQUOI IL VIT DANS `@nodaq/shared` (4.4, PR A). Ce registre est né côté
 * navigateur (2.21 A) : un écran déclare les ÉVÉNEMENTS qui le salissent, et
 * il n'a jamais à « penser » à se rafraîchir. Le bus d'événements serveur a
 * besoin exactement de la même correspondance pour son consommateur
 * « invalidation » — et la redéclarer de son côté aurait donné DEUX tables qui
 * divergent au premier ajout de vue. La panne de fraîcheur reviendrait alors
 * par la porte de derrière, sous une forme plus difficile à voir : deux
 * registres justes séparément, faux ensemble.
 *
 * Ce fichier ne contient donc que des DONNÉES et des fonctions pures. Le bus
 * lui-même — abonnements, émission, minuteries, `document.visibilitychange` —
 * reste dans `apps/web/lib/freshness.ts`, qui réexporte tout ce qui suit pour
 * que les écrans n'aient rien à changer.
 *
 * LE BUG D'ORIGINE : l'employé Compta exécutait une action, la base changeait,
 * et l'écran continuait d'afficher les anciens chiffres jusqu'à un
 * rechargement manuel. « Un cockpit qui ment est pire qu'un cockpit vide » —
 * en démo, « attendez, je rafraîchis » détruit la promesse d'un employé
 * virtuel.
 *
 * LE DIAGNOSTIC (les trois causes du ticket 2.21, dans l'ordre) :
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
 */

/** Bump à chaque ajout de vue ou d'événement. */
export const FRESHNESS_RULES_VERSION = "2026-08-06";

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
  "affaires",
  "contrats",
  "brief",
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
  | "action.echouee"
  | "document.ajoute"
  | "document.rattache"
  | "document.modifie"
  | "fec.importe"
  | "fec.purge"
  | "connecteur.modifie"
  | "module.bascule"
  | "prospect.modifie"
  | "prospect.efface"
  | "stock.modifie"
  | "rh.modifie"
  | "immobilisation.modifiee"
  | "cout.modifie"
  | "avis.modifie"
  | "echeance.modifiee"
  | "affaire.modifiee"
  | "affaire.imputee"
  | "profil.modifie"
  | "contrat.modifie";

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
  //
  // `affaires` depuis F6 : la fiche d'un chantier compte ce qui attend une
  // décision dessus, et cet événement porte AUSSI le rattachement d'une action
  // à un chantier. Sans lui, la fiche affichait « 2 à valider » alors que
  // l'action venait d'être rattachée ailleurs.
  "action.preparee": ["cockpit", "validation", "brief", "affaires"],
  // Une action VALIDÉE s'exécute. La liste suit ce que les exécuteurs écrivent
  // RÉELLEMENT (`apps/api/src/executors.ts`) : immobilisation, mouvement de
  // stock, avis client, contact prospect, dépôt de facture électronique — et
  // les agrégats qui s'en dérivent. Le classeur en est absent parce qu'AUCUN
  // exécuteur n'y écrit ; rafraîchir tout à chaque événement, c'est un cockpit
  // qui clignote et des requêtes pour rien.
  /*
   * Un exécuteur qui ÉCHOUE a pu écrire avant d'échouer : stock sorti puis
   * erreur, immobilisation créée puis erreur. Le ranger dans `action.rejetee`
   * — qui ne périme que la file — laissait ces écrans faux, et effaçait pour
   * tous les consommateurs futurs la différence entre « le patron a refusé »
   * et « ça a planté ». Mêmes vues que la réussite : on ne sait pas ce qui a
   * été écrit, donc on ne parie pas.
   */
  "action.echouee": [
    "nav",
    "cockpit",
    "brief",
    "validation",
    "tresorerie",
    "impayes",
    "marge",
    "stocks",
    "immobilisations",
    "prospects",
    "avis",
    "factures",
    "affaires",
  ],
  "action.validee": [
    "nav",
    "cockpit",
    "brief",
    "validation",
    "tresorerie",
    "impayes",
    "marge",
    "stocks",
    "immobilisations",
    "prospects",
    "avis",
    "factures",
    // F6 : décider fait sortir l'action du compteur « à valider » de la fiche
    // du chantier auquel elle était rattachée.
    "affaires",
  ],
  "action.rejetee": ["nav", "cockpit", "validation", "brief", "affaires"],
  // `validation` : au-delà du seuil de capitalisation, la pièce photographiée
  // fait naître une proposition d'immobilisation à valider (app.ts, classeur).
  // L'oublier laissait le badge de la nav faux après une photo de facture
  // d'équipement — le bug d'origine, sur le parcours le plus filmé du produit.
  "document.ajoute": ["cockpit", "classeur", "validation", "brief"],
  "document.rattache": ["classeur", "tresorerie"],
  // Correction de champs ou suppression d'une pièce. La trésorerie y figure
  // parce que supprimer une pièce RAPPROCHÉE défait le rapprochement : une
  // correction seule périmera la trésorerie pour rien, ce qui coûte une
  // requête — l'oublier coûterait un écran faux.
  // `validation` et `nav` : symétrique exact de `document.ajoute`. Ajouter une
  // photo de facture d'équipement DÉPOSE une proposition ; l'effacer la
  // REJETTE. N'invalider qu'au dépôt, c'était recréer le bug d'origine à
  // l'envers — un badge qui compte une proposition déjà retirée.
  "document.modifie": ["cockpit", "classeur", "tresorerie", "brief", "validation", "nav"],
  // Un import FEC remplace les créances dérivées : impayés, marge, cockpit —
  // ET remplit la file, puisqu'il propose jusqu'à 200 immobilisations à
  // valider (comptes 2x/28x). C'est le premier geste d'un nouveau client.
  // `rh` : sans facturier connecté, la performance horaire (€/h) tire son CA
  // du FEC (repli `FecPennylaneClient`). Un import change donc un chiffre
  // affiché sur un écran qui ne parle pourtant jamais de comptabilité.
  "fec.importe": [
    "cockpit",
    "brief",
    "connecteurs",
    "impayes",
    "marge",
    "tresorerie",
    "validation",
    "rh",
  ],
  // La purge efface ces mêmes dérivées — ET la file, désormais. Ce commentaire
  // affirmait l'inverse (« les propositions déjà déposées survivent ») : c'était
  // vrai, et c'était le défaut que le ticket d'effacement a corrigé. La purge
  // rejette et réduit jusqu'à 200 propositions, donc `validation` et `nav`
  // (le badge en dérive) doivent suivre, sans quoi l'écran continue d'afficher
  // des propositions qui n'existent plus.
  // `rh` y figure aussi : après purge, le €/h passe à « CA indisponible », et
  // laisser l'ancien chiffre à l'écran serait le pire des deux cas.
  "fec.purge": [
    "cockpit",
    "connecteurs",
    "impayes",
    "marge",
    "tresorerie",
    "rh",
    "brief",
    "validation",
    "nav",
  ],
  "connecteur.modifie": ["cockpit", "connecteurs", "tresorerie", "impayes"],
  // Éteindre un module retire des pages de la NAV et des cartes du cockpit :
  // les deux doivent suivre sans rechargement (pivot ADR-007).
  "module.bascule": ["nav", "cockpit", "connecteurs", "brief"],
  "prospect.modifie": ["prospects", "cockpit"],
  // Effacer une fiche (art. 17) ANONYMISE l'identité recopiée sur les affaires
  // jamais contractées : le nom du client disparaît d'une fiche chantier qu'un
  // autre onglet peut avoir sous les yeux. Événement distinct de
  // `prospect.modifie`, qui ne touche aucune affaire — périmer les affaires à
  // chaque changement d'étape ferait clignoter un écran pour rien.
  // `contrats` : l'effacement écrit aussi dans les contrats liés — nom et
  // notes anonymisés, `prospect_id` détaché par le SET NULL de la FK. Sans
  // cette entrée, l'écran Contrats continuerait d'afficher le nom qui vient
  // d'être effacé, ce qui est exactement le mensonge que ce registre existe
  // pour empêcher.
  "prospect.efface": ["prospects", "cockpit", "affaires", "contrats"],
  // Le cockpit affiche les alertes de stock (quand le module est actif).
  "stock.modifie": ["stocks", "cockpit", "brief"],
  // Salariés, absences, synchro paie. `marge` est de la sur-invalidation
  // ASSUMÉE : `analyze_margin` ne lit ni les salariés ni les immobilisations,
  // il lit les charges saisies et les factures — le lien passe par les comptes
  // 64x/68x du FEC, il est indirect. On recharge pour rien plutôt que de
  // risquer un écran faux, mais que personne ne s'appuie sur un lien direct.
  // `brief` en fait partie : l'effectif actif alimente le profil fiscal, et il
  // fait basculer la date de dépôt DSN du 15 au 5 (DSN_EARLY_FILING_HEADCOUNT).
  // Embaucher change donc l'échéance affichée le lendemain matin.
  "rh.modifie": ["rh", "marge", "brief"],
  "immobilisation.modifiee": ["immobilisations", "marge"],
  "cout.modifie": ["marge"],
  "avis.modifie": ["avis"],
  // Le cockpit affiche la prochaine échéance fiscale (owner).
  "echeance.modifiee": ["echeancier", "cockpit", "brief"],
  // Création, modification, archivage d'une affaire (4.1). `cockpit` depuis F4 :
  // il affiche désormais la marge de chaque chantier.
  "affaire.modifiee": ["affaires", "cockpit", "brief"],
  // Rattacher une pièce touche AUSSI le classeur (le document y affiche son
  // affaire) ET le cockpit depuis F4 : une dépense de plus change la marge du
  // chantier. La ligne annoncée par le commentaire d'origine a bougé, et rien
  // d'autre n'a eu à bouger — c'était le pari de cette config.
  "affaire.imputee": ["affaires", "classeur", "cockpit", "brief"],
  /*
   * Le VERTICAL du tenant change — et c'est l'événement qui périme le plus de
   * mots à la fois (4.2).
   *
   * Le vertical pilote deux choses très différentes : le VOCABULAIRE
   * (`affaireWords`, donc « chantier » / « événement » / « intervention » sur
   * les affaires, la marge, le brief et le cockpit) et les DÉFAUTS DE MODULES
   * (`resolveModules`, donc la navigation).
   *
   * Il était déclaré « ne périme rien », ce qui était déjà faux et que les
   * packs rendent visible : un paysagiste se déclare pour la première fois, et
   * l'écran Affaires continue de lui dire « affaire » jusqu'au rechargement —
   * exactement le moment où le produit devait lui parler sa langue.
   */
  "profil.modifie": ["affaires", "marge", "cockpit", "brief", "nav"],
  /*
   * Un contrat change, ou ses échéances deviennent des affaires (4.2 bloc 2).
   *
   * `affaires` et `marge` en font partie parce que matérialiser CRÉE des
   * affaires devisées : la liste des chantiers et la marge globale sont
   * fausses l'instant d'après. `brief` parce que le compteur « passages à
   * planifier » vient de tomber à zéro — le laisser afficher son ancien
   * chiffre juste après le clic serait la démonstration ratée type.
   */
  "contrat.modifie": ["contrats", "affaires", "marge", "cockpit", "brief"],
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
  draft_quote_from_dictation: "action.preparee",
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
  // F6 — rattacher une action à un chantier périme la file ET la fiche du
  // chantier (des deux côtés : celui qu'on quitte, celui qu'on rejoint).
  setPendingActionAffaire: ["action.preparee"],
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
  deleteProspect: ["prospect.efface"],
  // Avis clients
  createReview: ["avis.modifie"],
  importReviews: ["avis.modifie"],
  deleteReview: ["avis.modifie"],
  // Ces trois-là n'écrivent PAS le métier : ils déposent une action à valider.
  // C'est la file (et le badge de la nav) qu'ils périment, pas leur page.
  draftReviewReply: ["action.preparee"],
  draftQuoteFromEmail: ["action.preparee"],
  draftQuoteFromDictation: ["action.preparee"],
  proposeEReporting: ["action.preparee"],
  // Affaires (4.1) — le pivot du produit
  createAffaire: ["affaire.modifiee"],
  updateAffaire: ["affaire.modifiee"],
  archiveAffaire: ["affaire.modifiee"],
  imputeToAffaire: ["affaire.imputee"],
  removeImputation: ["affaire.imputee"],
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
  // Contrats récurrents (4.2 bloc 2).
  createContrat: ["contrat.modifie"],
  setContratStatus: ["contrat.modifie"],
  setContratProspect: ["contrat.modifie"],
  materialiserContrat: ["contrat.modifie"],
  // Registre RGPD : lu par sa page uniquement.
  addActivityFromTemplate: null,
  deleteActivity: null,
  // Le profil de veille, LUI, ne l'est pas : il porte le vertical, donc le mot
  // affiché sur la moitié du produit et les défauts de modules de la nav.
  putComplianceProfile: ["profil.modifie"],
  // Back-office support (schéma `ops`, 2.18) : hors des vues d'un tenant.
  updateSupportDraft: null,
  sendSupportReply: null,
  resolveSupportTicket: null,
  validateSupportIssue: null,
};

