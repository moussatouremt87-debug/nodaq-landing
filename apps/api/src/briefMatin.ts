/*
 * F5 — le brief du matin.
 *
 * Le patron ouvre son téléphone à 7 h, avant le café, sur un chantier. Il lit
 * trois lignes et décide de sa journée. C'est le premier écran du produit et
 * le plus lu — donc celui où un chiffre inventé fait le plus de dégâts.
 *
 * ZÉRO LLM, et c'est une décision, pas une paresse : un « brief » est
 * exactement l'endroit où la génération de prose est tentante, et exactement
 * l'endroit où une phrase plausible mais fausse est crue sans vérification.
 * Tout ici est assemblé à partir de chiffres déjà calculés par des moteurs
 * déterministes (marge 4.1, échéancier 2.9, impayés US-8).
 *
 * TROIS RÈGLES :
 *
 *  1. « Rien d'urgent » EST un brief. Meubler une matinée calme avec du
 *     remplissage apprend au patron à ne plus lire — ce qui tue la feature plus
 *     sûrement qu'une journée vide.
 *  2. Ce qu'on n'a PAS pu regarder est dit. Un brief qui omet silencieusement
 *     les impayés parce qu'aucun facturier n'est connecté laisse croire qu'il
 *     n'y en a pas. C'est le pire mensonge possible sur cet écran-là.
 *  3. Chaque ligne mène quelque part. Une alerte sans action est une source
 *     d'anxiété, pas une information.
 */

/** Bump à chaque changement de règle de composition ou de seuil. */
export const BRIEF_RULES_VERSION = "2026-08-03";

/**
 * Sévérité — l'ordre est celui de l'affichage, et il est fixe.
 *
 * `urgent` = de l'argent part ou ne rentre pas aujourd'hui ; `attention` = ça
 * dérive et il est encore temps ; `info` = à savoir, pas à faire.
 */
export const BRIEF_SEVERITIES = ["urgent", "attention", "info"] as const;
export type BriefSeverity = (typeof BRIEF_SEVERITIES)[number];

export type BriefItemKind =
  | "actions_a_valider"
  | "affaire_en_perte"
  | "budget_depasse"
  | "echeance_en_retard"
  | "echeance_proche"
  | "impayes"
  | "stock_sous_seuil"
  | "documents_a_verifier";

export interface BriefItem {
  readonly kind: BriefItemKind;
  readonly severity: BriefSeverity;
  /** Français, prêt à afficher — jamais un code brut. */
  readonly label: string;
  readonly count: number | null;
  /** Montant en centimes. `null` = pas de montant à ce niveau, jamais zéro par défaut. */
  readonly amountCents: number | null;
  /**
   * Ce que le montant EST, en français, quand il n'est pas évident.
   *
   * « −1 500 € » sous « 3 affaires perdent de l'argent » se lit comme un total
   * alors que c'est la pire des trois ; et un plafond rendu nu se lit comme une
   * marge exacte. Le qualificatif voyage AVEC le chiffre plutôt que d'être
   * reconstruit par chaque écran — un écran qui oublierait la nuance rendrait
   * un chiffre faux sans jamais planter.
   */
  readonly amountNote: string | null;
  /** Chaque ligne mène quelque part : une alerte sans action est une anxiété. */
  readonly href: string;
}

/** Un domaine que le brief n'a PAS pu examiner, et pourquoi. */
export interface BriefBlindSpot {
  readonly area: string;
  readonly why: string;
}

/**
 * Résultat — union discriminée : une matinée calme n'est pas une liste vide
 * qu'un écran pourrait rendre comme un brief raté.
 */
export type MorningBrief =
  | { readonly kind: "calme"; readonly blindSpots: readonly BriefBlindSpot[] }
  | {
      readonly kind: "brief";
      readonly items: readonly BriefItem[];
      readonly blindSpots: readonly BriefBlindSpot[];
    };

/** Une échéance fiscale devient « proche » à sept jours. */
export const ECHEANCE_HORIZON_DAYS = 7;

/** En deçà, une échéance n'attend plus : elle coûte déjà. */
export const ECHEANCE_URGENT_DAYS = 3;

/**
 * Profondeur de recherche des échéances en retard.
 *
 * Deux mois : de quoi couvrir un cycle déclaratif complet sans transformer le
 * brief en archive. Une échéance oubliée depuis un an n'est plus l'information
 * du matin — elle reste visible sur l'écran Échéancier, qui n'est pas borné.
 */
export const BRIEF_LATE_LOOKBACK_DAYS = 60;

/**
 * La pire marge connue d'un lot d'affaires, et sur quelle base elle est connue.
 *
 * `au_mieux` = plafond (`marge_borne_superieure`) : la marge réelle est PIRE ou
 * égale. Les deux ne se mélangent pas dans un `number` — un plafond aplati en
 * marge exacte, c'est un chiffre faux rendu sans le moindre signe extérieur.
 */
export interface BriefWorstMargin {
  readonly cents: number;
  readonly basis: "exact" | "au_mieux";
}

/**
 * Une échéance fiscale du calendrier (2.9), vue par le brief.
 *
 * `dateIsApproximate` remonte jusqu'ici parce qu'il change la PHRASE : la date
 * rendue par le calendrier est alors la borne basse d'une fenêtre légale, et
 * « dans 2 jours » y serait une certitude que nous n'avons pas.
 */
export interface BriefEcheance {
  /** Jours restants (≥ 0) pour `prochaine`, jours de retard (> 0) pour `enRetard`. */
  readonly days: number;
  /** Montant DÉCLARÉ par le dirigeant. `null` = inconnu, jamais estimé. */
  readonly amountCents: number | null;
  readonly dateIsApproximate: boolean;
}

export interface BriefInput {
  /** Actions en attente de validation. */
  readonly pendingActions: number;
  /** Affaires dont la marge connue est négative (F4). `null` = non regardé. */
  readonly affairesEnPerte: {
    readonly count: number;
    readonly worst: BriefWorstMargin;
  } | null;
  /** Affaires dont le budget matière est dépassé (F4). `null` = non regardé. */
  readonly budgetsDepasses: number | null;
  /**
   * Échéancier fiscal (2.9). `null` = non regardé (membre, ou module éteint).
   *
   * DEUX créneaux, jamais un seul : une échéance en retard et la prochaine à
   * venir sont deux problèmes distincts, et n'en garder qu'un laissait une
   * pénalité vieille de deux mois masquer la CA3 due après-demain.
   */
  readonly echeances: {
    /** La PLUS ANCIENNE échéance encore due et déjà passée. */
    readonly enRetard: BriefEcheance | null;
    /** La prochaine à venir, dans l'horizon. */
    readonly prochaine: BriefEcheance | null;
  } | null;
  /** Impayés exigibles — retenue de garantie EXCLUE (US-8). `null` = non regardé. */
  readonly impayes: { readonly count: number; readonly totalCents: number } | null;
  /** Articles sous le seuil d'alerte. `null` = module éteint ou non regardé. */
  readonly stockSousSeuil: number | null;
  /** Pièces photographiées en attente de vérification. */
  readonly documentsAVerifier: number;
  /** Ce que le brief n'a pas pu examiner, avec la raison. */
  readonly blindSpots: readonly BriefBlindSpot[];
}

const SEVERITY_ORDER: Record<BriefSeverity, number> = { urgent: 0, attention: 1, info: 2 };

/**
 * Compose le brief. PURE : aucune I/O, aucune horloge, aucun appel modèle.
 *
 * Rien n'est inventé ni arrondi ici : chaque nombre vient d'un moteur qui l'a
 * déjà calculé et testé. Cette fonction décide seulement de ce qui MÉRITE
 * d'être lu à 7 h, et dans quel ordre.
 */
export function composeMorningBrief(input: BriefInput): MorningBrief {
  const items: BriefItem[] = [];

  // De l'argent qui part : une affaire en perte est le seul cas où le patron
  // peut encore changer quelque chose aujourd'hui.
  if (input.affairesEnPerte !== null && input.affairesEnPerte.count > 0) {
    const { count, worst } = input.affairesEnPerte;
    items.push({
      kind: "affaire_en_perte",
      severity: "urgent",
      label: count === 1 ? "1 affaire perd de l'argent" : `${count} affaires perdent de l'argent`,
      count,
      amountCents: worst.cents,
      // Ni un total, ni forcément une marge exacte : les deux malentendus
      // possibles sur ce chiffre-là sont écrits à côté de lui.
      amountNote:
        worst.basis === "au_mieux"
          ? count === 1
            ? "au mieux — la marge réelle est pire"
            : "la pire, au mieux — la marge réelle est pire"
          : count === 1
            ? null
            : "la pire des affaires concernées",
      href: "/affaires",
    });
  }

  // De l'argent qui ne rentre pas.
  if (input.impayes !== null && input.impayes.count > 0) {
    items.push({
      kind: "impayes",
      severity: "urgent",
      label:
        input.impayes.count === 1
          ? "1 facture en retard de paiement"
          : `${input.impayes.count} factures en retard de paiement`,
      count: input.impayes.count,
      amountCents: input.impayes.totalCents,
      amountNote: "total exigible, retenue de garantie exclue",
      href: "/",
    });
  }

  // Une échéance DÉJÀ passée et toujours due : la pénalité court, et elle ne
  // doit pas occuper la place de la suivante — c'est un problème distinct.
  const enRetard = input.echeances?.enRetard ?? null;
  if (enRetard !== null) {
    items.push({
      kind: "echeance_en_retard",
      severity: "urgent",
      label:
        enRetard.days === 1
          ? "Une échéance fiscale est en retard d'1 jour"
          : `Une échéance fiscale est en retard de ${enRetard.days} jours`,
      count: null,
      amountCents: enRetard.amountCents,
      amountNote: enRetard.amountCents === null ? null : "montant que vous avez déclaré",
      href: "/echeancier",
    });
  }

  // Une échéance fiscale ratée coûte une pénalité : urgent à trois jours.
  const prochaine = input.echeances?.prochaine ?? null;
  if (prochaine !== null && prochaine.days <= ECHEANCE_HORIZON_DAYS) {
    items.push({
      kind: "echeance_proche",
      severity: prochaine.days <= ECHEANCE_URGENT_DAYS ? "urgent" : "attention",
      // Sur une date approximative, la borne rendue est celle du DÉBUT de la
      // fenêtre légale : « dans 2 jours » y serait une certitude inventée.
      label: prochaine.dateIsApproximate
        ? prochaine.days === 0
          ? "Une échéance fiscale s'ouvre aujourd'hui (date exacte selon votre espace professionnel)"
          : `Échéance fiscale à préparer sous ${prochaine.days} jour${prochaine.days === 1 ? "" : "s"} (date exacte selon votre espace professionnel)`
        : prochaine.days === 0
          ? "Une échéance fiscale est due aujourd'hui"
          : `Échéance fiscale dans ${prochaine.days} jour${prochaine.days === 1 ? "" : "s"}`,
      count: null,
      amountCents: prochaine.amountCents,
      amountNote: prochaine.amountCents === null ? null : "montant que vous avez déclaré",
      href: "/echeancier",
    });
  }

  // Ça dérive, et il est encore temps.
  if (input.budgetsDepasses !== null && input.budgetsDepasses > 0) {
    items.push({
      kind: "budget_depasse",
      severity: "attention",
      label:
        input.budgetsDepasses === 1
          ? "1 affaire dépasse son budget matière"
          : `${input.budgetsDepasses} affaires dépassent leur budget matière`,
      count: input.budgetsDepasses,
      amountCents: null,
      amountNote: null,
      href: "/affaires",
    });
  }

  if (input.pendingActions > 0) {
    items.push({
      kind: "actions_a_valider",
      severity: "attention",
      label:
        input.pendingActions === 1
          ? "1 action attend votre validation"
          : `${input.pendingActions} actions attendent votre validation`,
      count: input.pendingActions,
      amountCents: null,
      amountNote: null,
      href: "/validation",
    });
  }

  if (input.stockSousSeuil !== null && input.stockSousSeuil > 0) {
    items.push({
      kind: "stock_sous_seuil",
      severity: "attention",
      label:
        input.stockSousSeuil === 1
          ? "1 article sous le seuil d'alerte"
          : `${input.stockSousSeuil} articles sous le seuil d'alerte`,
      count: input.stockSousSeuil,
      amountCents: null,
      amountNote: null,
      href: "/stocks",
    });
  }

  // À savoir, pas à faire : ça peut attendre midi.
  if (input.documentsAVerifier > 0) {
    items.push({
      kind: "documents_a_verifier",
      severity: "info",
      label:
        input.documentsAVerifier === 1
          ? "1 pièce photographiée à vérifier"
          : `${input.documentsAVerifier} pièces photographiées à vérifier`,
      count: input.documentsAVerifier,
      amountCents: null,
      amountNote: null,
      href: "/classeur",
    });
  }

  // Tri STABLE : à sévérité égale, l'ordre d'insertion ci-dessus fait foi.
  // Deux briefs identiques doivent se lire à l'identique — un ordre qui bouge
  // d'un matin à l'autre donne l'impression que quelque chose a changé.
  const sorted = [...items].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  // Une matinée calme reste un brief COMPLET : les angles morts sont dits même
  // quand il n'y a rien à signaler, sinon « rien d'urgent » voudrait dire
  // « rien vu » sans le préciser.
  if (sorted.length === 0) return { kind: "calme", blindSpots: input.blindSpots };
  return { kind: "brief", items: sorted, blindSpots: input.blindSpots };
}
