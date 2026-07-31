/*
 * Vocabulaire de la prospection (ticket 2.12).
 *
 * Ces trois listes sont partagées par TROIS gardes qui doivent dire la même
 * chose : la validation Zod des routes, les CHECK de la base (défense en
 * profondeur) et le moteur de relance. Trois copies auraient fini par
 * diverger, et une étape acceptée par la route mais inconnue du moteur
 * rendrait une fiche invisible dans le pipeline sans que personne le voie.
 */

/**
 * Étapes du pipeline. Fermé : une étape libre rendrait les seuils de relance
 * inapplicables et la colonne ininterprétable.
 */
export const PROSPECT_STAGES = [
  "nouveau",
  "contacte",
  "qualifie",
  "devis_envoye",
  "gagne",
  "perdu",
] as const;
export type ProspectStage = (typeof PROSPECT_STAGES)[number];

/**
 * Provenance de la fiche. EXIGÉE à la création : le RGPD impose de pouvoir
 * dire d'où vient une donnée qui n'a pas été collectée auprès de la personne
 * (art. 14), et c'est aussi ce qui permet de justifier l'intérêt légitime.
 *
 * `achat_fichier` est volontairement ABSENT : la licéité d'un fichier acheté
 * se juge fichier par fichier (origine, information des personnes, opposition
 * recueillie). Le produit ne la légitime pas d'avance par une case à cocher.
 */
export const PROSPECT_SOURCES = [
  "demande_entrante",
  "recommandation",
  "salon",
  "reseau_pro",
  "site_web",
  "saisie_manuelle",
] as const;
export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

/** Nature d'un contact consigné au journal. */
export const INTERACTION_KINDS = ["appel", "email", "rdv", "autre"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];
