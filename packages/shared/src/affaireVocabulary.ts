import { VERTICALS, type Vertical } from "./regulatoryWatch.js";

/*
 * Vocabulaire de l'affaire (ticket 4.1) — LE MOT VIENT D'ICI, JAMAIS DU CODE.
 *
 * « Chantier » pour le bâtiment, « événement » pour le traiteur,
 * « intervention » pour la maintenance, « mission » pour les services. Un
 * `if (vertical === "industrie_btp")` dans un écran transforme un produit en
 * cinq produits à maintenir : le jour du pack traiteur, on paie chaque
 * occurrence. Une feature lit `affaireWords(vertical)` et ne sait rien de plus.
 *
 * PROVISOIRE ET ASSUMÉ : les cinq verticaux ci-dessous sont ceux du produit
 * actuel (3.7), hérités de l'ancienne segmentation — ils ne recouvrent PAS la
 * cible du pivot (bâtiment, paysage, événementiel, maintenance, services au
 * projet). Le ticket 4.2 apporte les vrais packs ; ce fichier est alors leur
 * point d'absorption, pas un concurrent. D'ici là, tout vertical sans mot
 * propre reçoit « affaire » — un mot neutre et juste, jamais un mot deviné.
 */

/** Bump à chaque ajout ou correction de vocabulaire. */
export const AFFAIRE_VOCABULARY_VERSION = "2026-08-03";

export interface AffaireWords {
  /** « chantier » — minuscule, l'écran capitalise s'il en a besoin. */
  readonly singular: string;
  readonly plural: string;
  /** « un chantier » / « une mission » : l'article évite d'accorder à la main. */
  readonly indefinite: string;
  /** « le chantier » / « la mission ». */
  readonly definite: string;
  /** Libellé d'action, déjà accordé — « Nouveau chantier », « Nouvelle mission ». */
  readonly newLabel: string;
  /** Vide accordé — « Aucun chantier », « Aucune mission ». Le genre appartient
   *  au vocabulaire : un écran qui teste `singular === "affaire"` pour choisir
   *  un « e » réintroduit une règle de langue dans une feature. */
  readonly noneLabel: string;
}

const AFFAIRE: AffaireWords = {
  singular: "affaire",
  plural: "affaires",
  indefinite: "une affaire",
  definite: "l'affaire",
  newLabel: "Nouvelle affaire",
  noneLabel: "Aucune affaire",
};

const CHANTIER: AffaireWords = {
  singular: "chantier",
  plural: "chantiers",
  indefinite: "un chantier",
  definite: "le chantier",
  newLabel: "Nouveau chantier",
  noneLabel: "Aucun chantier",
};

const MISSION: AffaireWords = {
  singular: "mission",
  plural: "missions",
  indefinite: "une mission",
  definite: "la mission",
  newLabel: "Nouvelle mission",
  noneLabel: "Aucune mission",
};

/**
 * Vocabulaire par vertical. Exhaustif par construction (`Record<Vertical, …>`) :
 * ajouter un vertical sans lui donner de mot ne compile pas.
 */
export const AFFAIRE_VOCABULARY: Record<Vertical, AffaireWords> = {
  industrie_btp: CHANTIER,
  services: MISSION,
  // Négoce et retail ne travaillent pas « à l'affaire » : ils sont hors cible
  // du pivot. Le mot neutre est le seul honnête tant qu'aucun pack ne le dit.
  negoce: AFFAIRE,
  retail: AFFAIRE,
  autre: AFFAIRE,
};

/**
 * Mots à afficher pour un tenant. `null`, inconnu, ou vertical non renseigné →
 * « affaire ». Ne devine JAMAIS à partir du nom de l'entreprise ou de ses
 * pièces : se tromper de mot devant un client est gratuit et ridicule.
 */
export function affaireWords(vertical: string | null | undefined): AffaireWords {
  if (!vertical) return AFFAIRE;
  return (VERTICALS as readonly string[]).includes(vertical)
    ? AFFAIRE_VOCABULARY[vertical as Vertical]
    : AFFAIRE;
}
