/*
 * Marge d'une affaire — calcul DÉTERMINISTE (ticket 4.1).
 *
 * Zéro LLM, zéro appel réseau, zéro accès base : cette fonction reçoit des
 * nombres et rend des nombres. C'est ce qui permet de la tester contre des cas
 * calculés à la main, et c'est la seule façon d'oser afficher un chiffre au
 * patron d'une TPE en lui disant que c'est le sien.
 *
 * LA RÈGLE QUI COMMANDE TOUT LE RESTE : une marge trop belle est pire qu'une
 * absence de marge. Elle fait accepter un chantier qui perd de l'argent, et
 * elle ne se fait remarquer qu'au bilan. Toutes les décisions ci-dessous en
 * découlent :
 *
 *  - aucun coût imputé  -> « données insuffisantes », jamais 100 % de marge ;
 *  - aucun devis        -> les coûts, et AUCUNE marge (elle serait inventée) ;
 *  - un coût INCONNU    -> « borne supérieure », un TYPE distinct que l'écran
 *                          ne peut pas confondre avec une marge exacte ;
 *  - un montant en TTC  -> jamais converti en HT sans le taux réel de la pièce,
 *                          tenu à part et COMPTÉ ;
 *  - un acompte         -> de la trésorerie encaissée, jamais un gain.
 */

/** Bump à chaque changement de règle de calcul. */
export const AFFAIRE_MARGIN_RULES_VERSION = "2026-08-03";

/** Cibles imputables. Les transactions bancaires ne sont pas stockées : leur
 *  identifiant est EXTERNE, d'où un type et non une clé étrangère. */
export type AffaireTargetType =
  | "classeur_document"
  | "transaction_bancaire"
  | "facture"
  | "charge";

export interface AffaireImputationInput {
  readonly targetType: AffaireTargetType;
  /** Instantané pris à l'imputation. `null` = montant inconnu, ce qui est DIT. */
  readonly amountCents: number | null;
  readonly amountBasis: "ht" | "ttc" | null;
  readonly subcontract: boolean;
}

export interface AffaireCostInput {
  /** Montant DEVISÉ HT. `null` = pas de devis, donc pas de marge. */
  readonly quotedAmountCents: number | null;
  readonly imputations: readonly AffaireImputationInput[];
  /** Heures passées. `null` = INCONNU (pas de table de temps aujourd'hui) ; 0 = déclaré nul. */
  readonly hoursWorked: number | null;
  /** Coût horaire chargé du tenant. `null` = non renseigné, jamais deviné. */
  readonly hourlyCostCents: number | null;
  readonly invoicedCents: number;
  /**
   * Base du montant facturé. Les factures dérivées du FEC sont la somme des
   * débits du compte 411 : c'est du TTC. Le devis, lui, est du HT. Soustraire
   * l'un de l'autre sous-estime le reste à facturer d'environ la TVA — le
   * patron arrêterait de facturer trop tôt. On ne soustrait donc QUE des bases
   * comparables, et on dit pourquoi quand on ne peut pas.
   */
  readonly invoicedBasis: "ht" | "ttc";
  /** Acomptes encaissés — exposés, jamais comptés en marge. */
  readonly depositsCents: number;
  /** Taux de retenue en points de base (500 = 5 %). */
  readonly retentionRateBps: number | null;
  /** Coût matière prévu au devis, pour l'écart budget. */
  readonly estimatedMaterialCents: number | null;
}

/** Ce qui manque pour un calcul exact — affiché tel quel, jamais tu. */
export type AffaireMissing =
  | "couts"
  | "heures"
  | "cout_horaire"
  | "pieces_ttc"
  | "montants_inconnus"
  | "aucune_piece_rattachee"
  | "facture_base_ttc";

export interface AffaireBudgetGap {
  readonly deltaCents: number;
  /** Écart relatif au budget, en points de base (−1250 = −12,5 %). */
  readonly deltaBps: number;
}

interface AffaireCostsBase {
  readonly materialCents: number;
  readonly subcontractCents: number;
  /** Pièces en TTC : tenues à part, jamais fondues dans le coût HT. */
  readonly ttcOnlyCents: number;
  readonly ttcOnlyCount: number;
  readonly unknownAmountCount: number;
  readonly depositsCents: number;
  readonly retentionCents: number;
}

/**
 * Résultat — UNION DISCRIMINÉE, volontairement.
 *
 * Un `marginCents: number | null` finirait affiché « 0 € de marge » par un
 * écran distrait. Ici, le champ n'existe PAS quand la marge n'est pas
 * calculable : l'erreur devient impossible à écrire.
 */
export type AffaireMargin =
  | (AffaireCostsBase & {
      readonly kind: "donnees_insuffisantes";
      readonly missing: readonly AffaireMissing[];
    })
  | (AffaireCostsBase & {
      readonly kind: "couts_seuls";
      readonly missing: readonly AffaireMissing[];
    })
  | (AffaireCostsBase & {
      readonly kind: "marge";
      readonly labourCents: number;
      readonly totalCostCents: number;
      readonly marginCents: number;
      readonly marginBps: number | null;
      /** `null` quand les bases ne sont pas comparables — jamais un chiffre faux. */
      readonly remainingToInvoiceCents: number | null;
      readonly budgetGap: AffaireBudgetGap | null;
      /**
       * Une marge EXACTE peut quand même reposer sur une base incomplète (aucune
       * pièce rattachée). Sans ce champ, la variante « exacte » n'avait aucun
       * moyen de le nuancer, et un chantier sans la moindre facture affichait
       * une marge présentée comme certaine.
       */
      readonly missing: readonly AffaireMissing[];
    })
  | (AffaireCostsBase & {
      readonly kind: "marge_borne_superieure";
      /** Marge AU MIEUX : les coûts inconnus ne peuvent que la diminuer. */
      readonly upperBoundCents: number;
      readonly remainingToInvoiceCents: number | null;
      readonly budgetGap: AffaireBudgetGap | null;
      readonly missing: readonly AffaireMissing[];
    });

function sumImputations(imputations: readonly AffaireImputationInput[]): AffaireCostsBase {
  let materialCents = 0;
  let subcontractCents = 0;
  let ttcOnlyCents = 0;
  let ttcOnlyCount = 0;
  let unknownAmountCount = 0;

  for (const imputation of imputations) {
    if (imputation.amountCents === null || imputation.amountBasis === null) {
      unknownAmountCount += 1;
      continue;
    }
    if (imputation.amountBasis === "ttc") {
      // Reconstituer un HT depuis un TTC demande le taux RÉEL de la pièce.
      // Prendre 20 % « parce que c'est le taux courant » fabriquerait un coût
      // faux sur chaque facture à 10 % ou 5,5 % — et le bâtiment en est plein.
      ttcOnlyCents += imputation.amountCents;
      ttcOnlyCount += 1;
      continue;
    }
    if (imputation.subcontract) subcontractCents += imputation.amountCents;
    else materialCents += imputation.amountCents;
  }

  return {
    materialCents,
    subcontractCents,
    ttcOnlyCents,
    ttcOnlyCount,
    unknownAmountCount,
    depositsCents: 0,
    retentionCents: 0,
  };
}

/**
 * Taux de TVA le PLUS ÉLEVÉ de France métropolitaine (20 %).
 *
 * Sert à borner, jamais à convertir. Diviser un TTC par le taux le plus haut
 * donne le HT le plus PETIT possible : un plancher de coût, donc un plafond de
 * marge — c'est une déduction, pas une supposition. Si la pièce était en
 * réalité à 5,5 %, son HT est plus grand, donc le coût réel est plus grand, et
 * la marge réelle plus basse que le plafond annoncé. L'erreur ne peut aller que
 * dans le sens prudent.
 */
const HIGHEST_VAT_RATE = 1.2;

/** Plancher de coût HT déductible d'un total TTC. */
function minimumHtOf(ttcCents: number): number {
  return Math.round(ttcCents / HIGHEST_VAT_RATE);
}

function budgetGapOf(materialCents: number, estimated: number | null): AffaireBudgetGap | null {
  // Sans budget prévu, il n'y a pas d'écart — il y a une absence de référence.
  if (estimated === null || estimated <= 0) return null;
  const deltaCents = materialCents - estimated;
  return { deltaCents, deltaBps: Math.round((deltaCents / estimated) * 10_000) };
}

export function computeAffaireMargin(input: AffaireCostInput): AffaireMargin {
  const sums = sumImputations(input.imputations);
  const retentionCents =
    input.quotedAmountCents !== null && input.retentionRateBps !== null
      ? Math.round((input.quotedAmountCents * input.retentionRateBps) / 10_000)
      : 0;
  const base: AffaireCostsBase = {
    ...sums,
    depositsCents: input.depositsCents,
    retentionCents,
  };

  const missing: AffaireMissing[] = [];
  if (sums.ttcOnlyCount > 0) missing.push("pieces_ttc");
  if (sums.unknownAmountCount > 0) missing.push("montants_inconnus");
  // Une marge calculée sans AUCUNE pièce rattachée est arithmétiquement exacte
  // et pratiquement fausse : un chantier de bâtiment sans la moindre facture
  // n'existe pas. On le dit même quand tout le reste est connu.
  if (input.imputations.length === 0) missing.push("aucune_piece_rattachee");

  const hasAnyCost =
    sums.materialCents > 0 ||
    sums.subcontractCents > 0 ||
    sums.ttcOnlyCount > 0 ||
    sums.unknownAmountCount > 0 ||
    (input.hoursWorked !== null && input.hoursWorked > 0);

  // Aucun coût du tout : la marge serait égale au devis, soit 100 %. Le chiffre
  // est exact et le message est un mensonge — on refuse de l'afficher.
  if (!hasAnyCost) {
    return { ...base, kind: "donnees_insuffisantes", missing: ["couts", ...missing] };
  }

  if (input.quotedAmountCents === null) {
    return { ...base, kind: "couts_seuls", missing };
  }

  const labourKnown = input.hoursWorked !== null && input.hourlyCostCents !== null;
  if (input.hoursWorked === null) missing.push("heures");
  if (input.hourlyCostCents === null && (input.hoursWorked === null || input.hoursWorked > 0)) {
    missing.push("cout_horaire");
  }

  const labourCents = labourKnown
    ? Math.round((input.hoursWorked as number) * (input.hourlyCostCents as number))
    : 0;
  const knownCostCents = sums.materialCents + sums.subcontractCents + labourCents;
  // Le reste à facturer EXCLUT la retenue de garantie : elle est due, pas
  // exigible. La compter ici déclencherait des relances injustifiées.
  //
  // Et il n'existe QUE si le facturé est dans la même base que le devis. Le
  // facturé vient des débits du compte 411 : c'est du TTC, le devis est du HT.
  // Soustraire les deux sous-estimerait le reste d'environ la TVA — le patron
  // arrêterait de facturer trop tôt, en croyant avoir tout facturé. Tant qu'on
  // n'a pas de facturé HT, on rend `null` et on DIT pourquoi.
  const basesComparable = input.invoicedCents === 0 || input.invoicedBasis === "ht";
  if (!basesComparable) missing.push("facture_base_ttc");
  const remainingToInvoiceCents = basesComparable
    ? Math.max(0, input.quotedAmountCents - input.invoicedCents - retentionCents)
    : null;
  const budgetGap = budgetGapOf(sums.materialCents, input.estimatedMaterialCents);

  // Un coût manquant ne peut que RÉDUIRE la marge : ce qu'on sait calculer est
  // donc un plafond, et il porte un type qui interdit de l'afficher autrement.
  // « aucune_piece_rattachee » nuance une marge, elle ne l'empêche pas : les
  // coûts sont connus (il n'y en a pas), la marge reste exacte. Idem pour une
  // base de facturation TTC, qui ne touche que le reste à facturer.
  const blocking = missing.filter(
    (item) => item !== "aucune_piece_rattachee" && item !== "facture_base_ttc",
  );
  if (blocking.length > 0) {
    return {
      ...base,
      kind: "marge_borne_superieure",
      // Les pièces en TTC ne sont pas ignorées : on en déduit le coût MINIMAL
      // possible. Les ignorer donnait « marge au mieux = le devis entier » dans
      // le flux le plus courant du produit (tout vient du classeur, donc tout
      // est en TTC) — le « 100 % de marge » que ce module refuse d'afficher,
      // sous une autre étiquette.
      upperBoundCents: input.quotedAmountCents - knownCostCents - minimumHtOf(sums.ttcOnlyCents),
      remainingToInvoiceCents,
      budgetGap,
      missing,
    };
  }

  const marginCents = input.quotedAmountCents - knownCostCents;
  return {
    ...base,
    kind: "marge",
    missing,
    labourCents,
    totalCostCents: knownCostCents,
    marginCents,
    // Une marge en % d'un devis à 0 € n'a pas de sens : on ne l'invente pas.
    marginBps:
      input.quotedAmountCents > 0
        ? Math.round((marginCents / input.quotedAmountCents) * 10_000)
        : null,
    remainingToInvoiceCents,
    budgetGap,
  };
}
