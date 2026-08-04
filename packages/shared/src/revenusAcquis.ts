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
export const REVENUS_VERSION = "2026-08-04";

export interface RevenuAffaireInput {
  /** Statut de l'affaire — c'est lui qui décide entre engagé et acquis. */
  readonly status: string;
  /** Montant DEVISÉ HT. `null` = valeur du travail inconnue. */
  readonly quotedAmountCents: number | null;
  /** Acomptes DÉCLARÉS par le dirigeant. */
  readonly depositsCents: number;
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
  /** Rien d'inconnu n'a été laissé de côté. */
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

/*
 * `ARCHIVEE` NE COMPTE PAS en acquis, et ce choix est le moins mauvais des
 * deux — pas le bon.
 *
 * Le problème : `status` est une colonne unique, donc archiver une affaire
 * terminée écrase `TERMINEE`. Le chiffre acquis d'un exercice baisse quand le
 * patron range. C'est une SOUS-estimation, elle est visible, et elle est dite
 * plus bas.
 *
 * La tentation était de rattraper avec `actualEndDate`. Elle a été essayée et
 * retirée : ce champ est libre, `POST /affaires/:id/archiver` accepte
 * n'importe quel statut de départ — `PERDUE` compris — et une affaire
 * abandonnée dont quelqu'un a saisi la date d'arrêt serait alors comptée à
 * 100 % du devis en acquis. Une SUR-estimation, invisible et flatteuse.
 *
 * « Jamais d'inférence quand le coût des deux erreurs est asymétrique » : on
 * garde celle qui se voit. Le vrai remède est une colonne `completedAt` posée
 * à la transition vers `TERMINEE` — un fait, pas une déduction.
 */

/**
 * Statuts qui comptent comme du travail VENDU.
 *
 * `PROSPECT` et `DEVIS_ENVOYE` en sont exclus : rien n'est signé, et compter
 * dessus c'est compter sur un client qui n'a pas dit oui. `PERDUE` et
 * `ARCHIVEE` ne comptent nulle part.
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

  for (const affaire of affaires) {
    // L'argent reçu est un FAIT, indépendant du statut : un acompte encaissé
    // sur une affaire finalement perdue est quand même sur le compte.
    encaisseDeclareCents += affaire.depositsCents;

    const livre = LIVRE.has(affaire.status);
    const vendu = VENDU.has(affaire.status);
    if (!livre && !vendu) continue;

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
    exact: sansDevis === 0,
  };
}
