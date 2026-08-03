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

export interface BriefInput {
  /** Actions en attente de validation. */
  readonly pendingActions: number;
  /** Affaires dont la marge connue est négative (F4). `null` = non regardé. */
  readonly affairesEnPerte: { readonly count: number; readonly worstCents: number } | null;
  /** Affaires dont le budget matière est dépassé (F4). `null` = non regardé. */
  readonly budgetsDepasses: number | null;
  /** Prochaine échéance fiscale, en jours et en centimes. `null` = non regardé. */
  readonly prochaineEcheance: { readonly days: number; readonly amountCents: number | null } | null;
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
    items.push({
      kind: "affaire_en_perte",
      severity: "urgent",
      label:
        input.affairesEnPerte.count === 1
          ? "1 affaire perd de l'argent"
          : `${input.affairesEnPerte.count} affaires perdent de l'argent`,
      count: input.affairesEnPerte.count,
      amountCents: input.affairesEnPerte.worstCents,
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
      href: "/",
    });
  }

  // Une échéance fiscale ratée coûte une pénalité : urgent à trois jours.
  if (input.prochaineEcheance !== null && input.prochaineEcheance.days <= ECHEANCE_HORIZON_DAYS) {
    items.push({
      kind: "echeance_proche",
      severity: input.prochaineEcheance.days <= 3 ? "urgent" : "attention",
      label:
        input.prochaineEcheance.days <= 0
          ? "Une échéance fiscale est due aujourd'hui"
          : `Échéance fiscale dans ${input.prochaineEcheance.days} jour(s)`,
      count: null,
      amountCents: input.prochaineEcheance.amountCents,
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
