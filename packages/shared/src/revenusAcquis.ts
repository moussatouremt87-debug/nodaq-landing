/*
 * Encaissé ≠ acquis (ticket 4.2, bloc 3) — MOTEUR PUR.
 *
 * LA CONFUSION QUE CE FICHIER EXISTE POUR RENDRE IMPOSSIBLE.
 *
 * Beaucoup de patrons de TPE jugent leur santé au solde du compte. Or trois
 * choses très différentes s'y ressemblent :
 *
 *  - **encaissé** : l'argent qui est SUR LE COMPTE. Des acomptes, des factures
 *    réglées. C'est du TTC, et une partie ne lui appartient pas (la TVA) ;
 *  - **engagé** : du travail VENDU mais pas encore livré. Un devis signé, une
 *    intervention de contrat planifiée ;
 *  - **acquis** : du travail LIVRÉ. C'est le seul des trois qui a produit du
 *    résultat.
 *
 * Le bloc 2 a rendu la faute facile à commettre : matérialiser douze passages
 * d'un contrat d'entretien crée douze affaires devisées d'un coup. Sommées
 * naïvement, elles font apparaître une année de chiffre d'affaires le jour du
 * clic — et une marge globale flatteuse sur du travail qui n'a pas commencé.
 * « Une marge trop belle est pire qu'une absence de marge. »
 *
 * DÉTERMINISTE et sans horloge : des nombres entrent, des nombres sortent.
 *
 * CE QUE CE MOTEUR REFUSE DE CALCULER. Il ne rend aucun écart entre encaissé
 * et acquis, et c'est délibéré : l'un est du TTC, l'autre du HT. Leur
 * différence vaudrait approximativement la TVA, c'est-à-dire de l'argent qui
 * n'appartient pas à l'entreprise. Un « reste à encaisser » calculé ainsi
 * ferait arrêter de facturer trop tôt. Les deux bases sont donc RENDUES, et
 * l'écran ne peut pas les soustraire sans le décider explicitement.
 */

/** Bump à chaque changement de règle de rattachement d'un statut. */
export const REVENUS_VERSION = "2026-08-04.1";

export interface RevenuAffaireInput {
  /** Statut de l'affaire — c'est lui qui décide entre engagé et acquis. */
  readonly status: string;
  /** Montant DEVISÉ HT. `null` = valeur du travail inconnue. */
  readonly quotedAmountCents: number | null;
  /** Acomptes DÉCLARÉS par le dirigeant. */
  readonly depositsCents: number;
  /**
   * Instant de la transition vers `TERMINEE`. `null` = jamais terminée.
   *
   * UN FAIT, PAS UNE DÉDUCTION : posé par la route au moment où le statut
   * devient `TERMINEE`, effacé si l'affaire repart vers un statut vivant, et
   * rien d'autre ne l'écrit. C'est ce qui le distingue d'`actualEndDate`, champ
   * libre qu'un archivage d'affaire abandonnée pouvait porter.
   */
  readonly completedAt: string | null;
}

export interface RevenusSplit {
  /** Travail LIVRÉ, en HT. Le seul des trois qui a produit du résultat. */
  readonly acquisCents: number;
  readonly acquisBasis: "ht";
  /** Travail VENDU mais pas encore livré, en HT. */
  readonly engageCents: number;
  readonly engageBasis: "ht";
  /**
   * Acomptes DÉCLARÉS, et factures RÉGLÉES — deux chiffres, jamais un seul.
   *
   * Les additionner double-compterait le cas standard du bâtiment : une
   * facture d'acompte est à la fois une pièce du FEC (réglée à 100 %) et un
   * acompte que le dirigeant déclare sur la fiche. 3 600 € deviendraient
   * 7 200 €, dans la direction flatteuse que ce fichier existe pour interdire.
   *
   * Rien ne permet de les rapprocher : une déclaration d'acompte ne porte
   * aucun lien vers la pièce comptable correspondante. On refuse donc de
   * sommer, et on le DIT — c'est la seule réponse honnête tant que le lien
   * n'existe pas.
   */
  readonly encaisseDeclareCents: number;
  /** `null` = aucune source comptable importée, jamais « zéro encaissé ». */
  readonly encaisseFactureCents: number | null;
  readonly encaisseBasis: "ttc";
  /**
   * Affaires signées SANS devis : leur valeur de travail est inconnue.
   *
   * Comptées et nommées, jamais ignorées en silence — sinon l'acquis serait
   * sous-estimé et présenté comme exact, sans que personne sache de combien.
   */
  readonly sansDevis: number;
  /**
   * Affaires ARCHIVÉES devisées mais sans date de livraison — leur montant
   * n'entre PAS dans l'acquis, et ce compteur le dit.
   *
   * Deux populations s'y mélangent, et rien ne permet de les distinguer :
   *  - celles archivées AVANT l'existence de `completedAt`, qui ont pu être
   *    livrées — la colonne n'a pas été rétro-remplie, parce que la déduire
   *    d'`actualEndDate` ou d'`updatedAt` serait l'inférence qu'elle remplace ;
   *  - celles archivées depuis, dont on sait qu'elles n'ont pas été livrées.
   *
   * Le compteur ne prétend donc PAS mesurer une incertitude : il énonce un
   * fait vérifiable — voilà ce qui est exclu, et voilà combien. Sans lui, une
   * affaire réellement livrée puis archivée avant la migration sortait de
   * l'acquis en silence : « un compteur qui disparaît sans un mot est une
   * donnée perdue. »
   */
  readonly archiveesHorsAcquis: number;
  readonly archiveesHorsAcquisCents: number;
  /**
   * Rien d'inconnu n'a été laissé de côté.
   *
   * NE BASCULE PAS sur `archiveesHorsAcquis`, et c'est délibéré. Exclure une
   * archivée sans date de livraison est une RÈGLE, appliquée à l'identique à
   * toutes — pas un calcul qui a échoué. Faire tomber `exact` dessus le
   * rendrait faux en permanence chez tout dirigeant qui archive ses devis
   * perdus, donc illisible : un indicateur toujours au rouge ne hiérarchise
   * plus rien, et il masquerait les deux inexactitudes réelles (une valeur de
   * travail inconnue, une lecture tronquée). Le montant exclu est rendu à
   * côté ; il est dit, pas caché derrière un booléen.
   */
  readonly exact: boolean;
}

/**
 * Statuts qui comptent comme du travail LIVRÉ.
 *
 * `TERMINEE` seulement. On pourrait être tenté de proratiser une affaire en
 * cours (« à moitié faite, donc la moitié acquise »), mais rien dans le
 * produit ne dit où en est un chantier : il n'existe pas de lignes de temps,
 * et l'avancement n'est pas saisi. Un pourcentage inventé serait exactement le
 * genre de chiffre flatteur que ce moteur existe pour empêcher.
 */
const LIVRE = new Set(["TERMINEE"]);

/**
 * `ARCHIVEE` compte en acquis SI, ET SEULEMENT SI, elle a été terminée.
 *
 * `status` est une colonne unique : archiver une affaire terminée écrase
 * `TERMINEE`, et le chiffre acquis d'un exercice baissait donc quand le patron
 * rangeait. Le bloc 3 assumait cette sous-estimation faute de mieux.
 *
 * Le rattrapage par `actualEndDate` avait été implémenté puis RETIRÉ : champ
 * libre, et `POST /affaires/:id/archiver` accepte n'importe quel statut de
 * départ — `PERDUE` compris. Une affaire abandonnée dont quelqu'un avait saisi
 * la date d'arrêt aurait compté à 100 % du devis : sur-estimation invisible et
 * flatteuse, exactement ce que ce moteur existe pour interdire.
 *
 * `completedAt` n'a pas ce défaut parce que ce n'est pas une déduction : il
 * est posé au moment de la transition, et une affaire jamais terminée ne peut
 * pas en porter un. On remplace une inférence par un fait — c'est la seule
 * façon de lever une sous-estimation sans ouvrir une sur-estimation.
 *
 * IL NE VAUT QUE POUR `ARCHIVEE`. Une affaire terminée puis REPRISE
 * (`TERMINEE -> EN_COURS`) est du travail en cours : la route efface son
 * `completedAt`, mais le moteur ne s'y fie pas. Deux gardes plutôt qu'une —
 * une seule suffirait à rendre un chiffre flatteur si l'autre cédait.
 */
const livreParArchivage = (affaire: RevenuAffaireInput): boolean =>
  affaire.status === "ARCHIVEE" && affaire.completedAt !== null;

/**
 * Statuts qui comptent comme du travail VENDU.
 *
 * `PROSPECT` et `DEVIS_ENVOYE` en sont exclus : rien n'est signé, et compter
 * dessus c'est compter sur un client qui n'a pas dit oui. `PERDUE` et
 * `ARCHIVEE` ne comptent pas comme du VENDU — une archivée porteuse d'un
 * `completedAt` compte en revanche comme du LIVRÉ (voir `livreParArchivage`).
 */
const VENDU = new Set(["ACCEPTEE", "EN_COURS"]);

/**
 * Répartit un ensemble d'affaires entre acquis, engagé et encaissé. PURE.
 *
 * L'encaissé est compté pour TOUTES les affaires, quel que soit leur statut :
 * un acompte reçu sur une affaire finalement perdue est quand même sur le
 * compte. C'est bien la différence entre « ce que j'ai » et « ce que j'ai
 * gagné ».
 */
export function splitRevenus(
  affaires: readonly RevenuAffaireInput[],
  /**
   * Part réglée des factures du tenant — agrégée à part (voir le type).
   *
   * OBLIGATOIRE, et `null` est une valeur légitime : un défaut à zéro
   * laisserait un appelant distrait rendre « 0 € de factures réglées », soit
   * le zéro muet que ce fichier combat.
   */
  encaisseFactureCents: number | null,
): RevenusSplit {
  let acquisCents = 0;
  let engageCents = 0;
  let encaisseDeclareCents = 0;
  let sansDevis = 0;
  let archiveesHorsAcquis = 0;
  let archiveesHorsAcquisCents = 0;

  for (const affaire of affaires) {
    // L'argent reçu est un FAIT, indépendant du statut : un acompte encaissé
    // sur une affaire finalement perdue est quand même sur le compte.
    encaisseDeclareCents += affaire.depositsCents;

    const livre = LIVRE.has(affaire.status) || livreParArchivage(affaire);
    const vendu = VENDU.has(affaire.status);
    if (!livre && !vendu) {
      // Ce qui sort de l'acquis faute de date de livraison est ANNONCÉ, avec
      // son montant : c'est la seule façon de savoir de combien il manque.
      if (
        affaire.status === "ARCHIVEE" &&
        affaire.completedAt === null &&
        affaire.quotedAmountCents !== null
      ) {
        archiveesHorsAcquis += 1;
        archiveesHorsAcquisCents += affaire.quotedAmountCents;
      }
      continue;
    }

    if (affaire.quotedAmountCents === null) {
      // Signée mais sans devis : on ne sait pas ce que vaut ce travail.
      sansDevis += 1;
      continue;
    }
    if (livre) acquisCents += affaire.quotedAmountCents;
    else engageCents += affaire.quotedAmountCents;
  }

  return {
    acquisCents,
    acquisBasis: "ht",
    engageCents,
    engageBasis: "ht",
    encaisseDeclareCents,
    encaisseFactureCents,
    encaisseBasis: "ttc",
    sansDevis,
    archiveesHorsAcquis,
    archiveesHorsAcquisCents,
    exact: sansDevis === 0,
  };
}
