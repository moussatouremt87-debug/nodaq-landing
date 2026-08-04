/*
 * Packs verticaux (ticket 4.2) — CONFIG VERSIONNÉE DATÉE, et surtout LE
 * fichier qui porte les métiers.
 *
 * LA RÈGLE D'ARCHITECTURE QUE CE FICHIER EXISTE POUR TENIR (ADR-007) :
 * « un vertical = un fichier de données, jamais une ligne de code métier. »
 * Un `if (vertical === "batiment")` dans une feature transforme un produit en
 * cinq produits à maintenir — le jour du pack traiteur, on repaie chaque
 * occurrence. Une feature lit `affaireWords(vertical)` ou `verticalLabel()`
 * et ne sait rien de plus. Si un pack semble exiger du code, c'est le MOTEUR
 * qu'il faut étendre, pas le pack qu'il faut brancher.
 *
 * CE FICHIER ABSORBE `affaireVocabulary.ts` (4.1), qui s'annonçait lui-même
 * comme provisoire : ses cinq verticaux étaient ceux de l'ancienne
 * segmentation (industrie/BTP, retail, négoce, services) et ne recouvraient
 * pas la cible du pivot.
 *
 * POURQUOI DIX VERTICAUX ET NON CINQ. La cible du pivot en compte cinq
 * (bâtiment, paysage, événementiel, maintenance, services au projet). Les
 * cinq anciens RESTENT, et ce n'est pas de la timidité :
 *
 * - ils sont en base. `tenant_profiles.vertical` porte un `CHECK` : retirer
 *   une valeur, c'est refuser d'enregistrer la fiche d'un tenant qui existe ;
 * - ils portent des OBLIGATIONS LÉGALES. `information-prix` (Code de la
 *   consommation, art. L112-1) est rattachée à `retail`/`negoce` dans la
 *   veille réglementaire. Supprimer ces verticaux retirerait silencieusement
 *   une obligation à un commerçant, par refonte d'un découpage commercial.
 *   Le coût des deux erreurs est asymétrique : un vertical de trop dans une
 *   liste se voit et se corrige, une obligation disparue ne se voit pas.
 *
 * `inTarget` dit lesquels sont la cible du pivot ; aucune feature n'a besoin
 * d'en savoir plus, et rien n'est supprimé.
 */

/** Bump à chaque ajout de pack ou correction de vocabulaire. */
export const VERTICAL_PACKS_VERSION = "2026-08-04";

/**
 * Verticaux STORABLES, dans l'ordre d'affichage : la cible du pivot d'abord,
 * l'ancienne segmentation ensuite, le neutre en dernier.
 *
 * Tuple `as const` et non dérivé des packs : `z.enum()` réclame des littéraux,
 * et la route de profil s'en sert pour valider l'entrée. La synchronisation
 * avec `VERTICAL_PACKS` est garantie par `Record<Vertical, …>` dans un sens et
 * par un test dans l'autre.
 *
 * **Toute modification ici exige une migration** : `tenant_profiles` porte un
 * `CHECK` sur cette liste (défense en profondeur), et un test vérifie que les
 * deux ne divergent pas.
 */
export const VERTICALS = [
  // Cible du pivot (ADR-007).
  "batiment",
  "paysage",
  "evenementiel",
  "maintenance",
  "services_projet",
  // Ancienne segmentation (3.7) — conservée : voir l'en-tête de fichier.
  "industrie_btp",
  "services",
  "negoce",
  "retail",
  "autre",
] as const;

export type Vertical = (typeof VERTICALS)[number];

/** Les cinq métiers que le pivot vise. Dérivé, jamais recopié. */
export const PIVOT_VERTICALS = [
  "batiment",
  "paysage",
  "evenementiel",
  "maintenance",
  "services_projet",
] as const satisfies readonly Vertical[];

/** Les mots d'un métier pour désigner son unité de travail. */
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

export interface VerticalPack {
  readonly id: Vertical;
  /** Français, prêt à afficher — sélecteur d'onboarding, fiche réglementaire. */
  readonly label: string;
  /**
   * Ce métier fait-il partie de la cible du pivot (ADR-007) ?
   *
   * `false` ne veut dire NI éteint NI déprécié : le tenant fonctionne
   * normalement. C'est une information de cadrage produit, pas une frontière
   * de sécurité et pas un interrupteur.
   */
  readonly inTarget: boolean;
  readonly words: AffaireWords;
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

const EVENEMENT: AffaireWords = {
  singular: "événement",
  plural: "événements",
  indefinite: "un événement",
  definite: "l'événement",
  // « Nouvel », pas « Nouveau » : masculin devant voyelle. C'est exactement le
  // genre de règle qu'on ne veut pas voir dériver dans un écran.
  newLabel: "Nouvel événement",
  noneLabel: "Aucun événement",
};

const INTERVENTION: AffaireWords = {
  singular: "intervention",
  plural: "interventions",
  indefinite: "une intervention",
  definite: "l'intervention",
  newLabel: "Nouvelle intervention",
  noneLabel: "Aucune intervention",
};

/**
 * Les packs. Exhaustif par construction (`Record<Vertical, …>`) : ajouter un
 * vertical sans lui écrire de pack ne compile pas.
 */
export const VERTICAL_PACKS: Record<Vertical, VerticalPack> = {
  batiment: {
    id: "batiment",
    label: "Bâtiment / travaux",
    inTarget: true,
    words: CHANTIER,
  },
  paysage: {
    id: "paysage",
    label: "Paysage / espaces verts",
    inTarget: true,
    // Un paysagiste dit « chantier » comme un maçon : le mot suit le métier,
    // pas la nomenclature.
    words: CHANTIER,
  },
  evenementiel: {
    id: "evenementiel",
    label: "Événementiel / traiteur",
    inTarget: true,
    words: EVENEMENT,
  },
  maintenance: {
    id: "maintenance",
    label: "Maintenance / dépannage",
    inTarget: true,
    words: INTERVENTION,
  },
  services_projet: {
    id: "services_projet",
    label: "Services au projet",
    inTarget: true,
    words: MISSION,
  },
  industrie_btp: {
    id: "industrie_btp",
    label: "Industrie / BTP (ancien découpage)",
    inTarget: false,
    // Conservé tel quel plutôt que renommé en `batiment` : « industrie ET BTP »
    // est plus large que « bâtiment ». Renommer d'office reclasserait un
    // industriel en entreprise de travaux, sans que personne l'ait demandé.
    words: CHANTIER,
  },
  services: {
    id: "services",
    label: "Services (ancien découpage)",
    inTarget: false,
    words: MISSION,
  },
  negoce: {
    id: "negoce",
    label: "Négoce",
    inTarget: false,
    // Négoce et retail ne travaillent pas « à l'affaire » — ils sont hors
    // cible. Le mot neutre est le seul honnête : inventer un mot de métier
    // pour un métier qu'on ne sert pas serait une promesse en trop.
    words: AFFAIRE,
  },
  retail: {
    id: "retail",
    label: "Commerce de détail",
    inTarget: false,
    words: AFFAIRE,
  },
  autre: {
    id: "autre",
    label: "Autre",
    inTarget: false,
    words: AFFAIRE,
  },
};

export interface VerticalChoice {
  readonly id: Vertical;
  readonly label: string;
}

/**
 * Les métiers proposables, EN DEUX GROUPES — pour un `<optgroup>`.
 *
 * Une version précédente masquait purement et simplement l'ancien découpage,
 * sauf s'il était déjà la valeur du tenant. C'était une régression, et de la
 * pire espèce : un tenant qui n'était pas déjà `retail` ne pouvait PLUS se
 * déclarer commerçant, donc ne recevrait jamais l'obligation d'information sur
 * les prix. Le `CHECK` gardait la valeur, l'écran la rendait inatteignable —
 * même résultat produit que si on l'avait supprimée, c'est-à-dire exactement
 * ce que la migration déclare inacceptable. Elle était en prime à sens unique :
 * un tenant passé de `industrie_btp` à `batiment` n'avait plus aucun moyen de
 * revenir.
 *
 * Les deux groupes sont donc TOUJOURS rendus. Le libellé du groupe suffit à
 * dire lequel est d'actualité ; c'est un guidage, pas une porte fermée.
 */
export function verticalChoices(): { cible: VerticalChoice[]; ancien: VerticalChoice[] } {
  const cible: VerticalChoice[] = [];
  const ancien: VerticalChoice[] = [];
  for (const id of VERTICALS) {
    const pack = VERTICAL_PACKS[id];
    // `autre` n'est pas un métier : c'est le refus de choisir, et il doit
    // rester à portée immédiate plutôt que rangé dans « ancien découpage ».
    (pack.inTarget || id === "autre" ? cible : ancien).push({ id, label: pack.label });
  }
  return { cible, ancien };
}

/**
 * Mots à afficher pour un tenant. `null`, inconnu, ou vertical non renseigné →
 * « affaire ». Ne devine JAMAIS à partir du nom de l'entreprise ou de ses
 * pièces : se tromper de mot devant un client est gratuit et ridicule.
 */
export function affaireWords(vertical: string | null | undefined): AffaireWords {
  return verticalPack(vertical).words;
}

/** Libellé affichable d'un vertical — inconnu compris, jamais une chaîne vide. */
export function verticalLabel(vertical: string | null | undefined): string {
  return verticalPack(vertical).label;
}

/** Pack d'un tenant, avec repli neutre. Seule porte d'accès aux données métier
 *  d'un vertical : une feature qui indexerait `VERTICAL_PACKS` à la main
 *  planterait sur une valeur inconnue venue de la base. */
export function verticalPack(vertical: string | null | undefined): VerticalPack {
  if (!vertical) return VERTICAL_PACKS.autre;
  return (VERTICALS as readonly string[]).includes(vertical)
    ? VERTICAL_PACKS[vertical as Vertical]
    : VERTICAL_PACKS.autre;
}
