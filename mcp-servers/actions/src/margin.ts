/*
 * Marge (ticket 2.8).
 *
 * Le ticket 2.11 avait laissé la marge de côté en écrivant pourquoi : « une
 * marge calculée sur une partie des charges serait fausse dans le sens
 * rassurant ». C'est exactement le problème que ce module doit résoudre, et
 * non contourner.
 *
 * Le danger est asymétrique. Une charge oubliée ne déplace pas la marge au
 * hasard : elle la fait toujours paraître MEILLEURE qu'elle n'est. Un gérant
 * qui lit « marge 42 % » alors qu'elle est à 18 % embauche, baisse ses prix,
 * s'engage — et découvre l'écart des mois plus tard.
 *
 * D'où la règle du module : **une base de charges incomplète ne produit pas un
 * chiffre, elle produit une BORNE SUPÉRIEURE.**
 *
 *   « Votre marge est AU PLUS de 42 % — deux postes ne sont pas renseignés. »
 *
 * C'est mathématiquement vrai (les charges manquantes ne peuvent que réduire
 * la marge) et impossible à confondre avec un résultat complet. Le champ
 * `marginRatio` n'existe même pas dans ce cas : aucun écran, aucun modèle ne
 * peut afficher un point là où il n'y a qu'un plafond.
 */

import { z } from "zod";
import { COST_CATEGORIES, COST_CATEGORY_IDS } from "@nodaq/shared";
import type { CostLevel } from "@nodaq/shared";
import { normalizeSaleInvoice } from "./salesForecast.js";
import type { ReportInvoice } from "./monthlyReport.js";

/** Bump quand la façon de conclure change (pas quand un compte bouge : 2.8). */
export const MARGIN_RULES_VERSION = "2026-07-31";

/** Une charge du mois, quelle que soit sa provenance. */
export const CostEntry = z.object({
  category: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amountCents: z.number().int(),
  /** `fec` = dérivée d'un import comptable ; `saisi` = déclarée par l'owner. */
  source: z.enum(["fec", "saisi"]),
});
export type CostEntry = z.infer<typeof CostEntry>;

export interface MarginLevel {
  level: CostLevel;
  label: string;
  /** Total des charges CONNUES de ce niveau (et des niveaux inférieurs). */
  costCents: number;
  /** Postes attendus dont aucune charge n'a été trouvée pour le mois. */
  missingCategories: string[];
  /**
   * Marge en centimes. Avec des postes manquants, c'est une BORNE
   * SUPÉRIEURE — la vraie marge est forcément plus basse.
   */
  marginCents: number;
  /**
   * Ratio marge/CA. `complete` = un chiffre ; `borne_superieure` = un plafond.
   * Un `marginRatio` distinct n'existe PAS : rien à afficher par erreur.
   */
  kind: "complete" | "borne_superieure";
  marginRatio: number;
  /** Phrase française CHIFFRÉE, déjà qualifiée. Le modèle relaie. */
  reason: string;
}

export interface MarginReport {
  month: string;
  rulesVersion: string;
  revenueCents: number;
  invoiceCount: number;
  /** Charges connues par poste, avec leur provenance. */
  costs: { category: string; label: string; amountCents: number; source: string }[];
  levels: MarginLevel[];
  /** Postes sans aucune charge sur le mois — dits, jamais supposés nuls. */
  missingCategories: { id: string; label: string }[];
  /** Règles non évaluées faute de données (ex. aucun CA). */
  notEvaluated: string[];
  excludedCount: number;
  unusableCount: number;
  label: string;
}

const MONTH = /^\d{4}-\d{2}$/;

const LEVEL_LABELS: Record<CostLevel, string> = {
  direct: "Marge brute (CA − coûts directs)",
  exploitation: "Marge d'exploitation (CA − toutes charges retenues)",
};

/** Ordre d'empilement : chaque niveau inclut les charges du précédent. */
const LEVEL_ORDER: CostLevel[] = ["direct", "exploitation"];

const euros = (cents: number): string =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })
    .format(cents / 100);

/**
 * Construit le rapport de marge d'un mois. PURE : aucune I/O, aucune horloge.
 *
 * `invoices` couvre au moins le mois analysé ; `costs` porte les charges déjà
 * connues (dérivées d'un FEC ou saisies). Rien n'est estimé : un poste sans
 * charge est un poste MANQUANT, jamais un poste à zéro.
 */
export function buildMarginReport(
  invoices: readonly ReportInvoice[],
  costs: readonly CostEntry[],
  month: string,
): MarginReport {
  if (!MONTH.test(month)) throw new Error("invalid month");

  // CA : la MÊME séquence de décisions qu'en 3.1 et 2.11 (brouillons, avoirs,
  // devise étrangère, montant illisible). Deux marges qui divergeraient du CA
  // affiché ailleurs seraient pires qu'une absence de marge.
  let revenueCents = 0;
  let invoiceCount = 0;
  let excludedCount = 0;
  let unusableCount = 0;
  for (const invoice of invoices) {
    const normalized = normalizeSaleInvoice(invoice);
    if (!normalized.ok) {
      if (normalized.reason === "exclue" || normalized.reason === "non_positif") excludedCount += 1;
      else unusableCount += 1;
      continue;
    }
    if (normalized.month !== month) continue;
    revenueCents += normalized.cents;
    invoiceCount += 1;
  }

  // Charges du mois par poste. Plusieurs entrées d'un même poste s'additionnent
  // (un import FEC puis une saisie complémentaire, par exemple).
  const byCategory = new Map<string, { amountCents: number; sources: Set<string> }>();
  for (const cost of costs) {
    if (cost.month !== month) continue;
    if (!COST_CATEGORY_IDS.includes(cost.category)) continue;
    const bucket = byCategory.get(cost.category) ?? { amountCents: 0, sources: new Set<string>() };
    bucket.amountCents += cost.amountCents;
    bucket.sources.add(cost.source);
    byCategory.set(cost.category, bucket);
  }

  const costLines = COST_CATEGORIES.filter((category) => byCategory.has(category.id)).map(
    (category) => {
      const bucket = byCategory.get(category.id);
      return {
        category: category.id,
        label: category.label,
        amountCents: bucket?.amountCents ?? 0,
        source: [...(bucket?.sources ?? [])].sort().join("+"),
      };
    },
  );

  const missing = COST_CATEGORIES.filter((category) => !byCategory.has(category.id));
  const notEvaluated: string[] = [];
  const levels: MarginLevel[] = [];

  if (revenueCents <= 0) {
    // Dénominateur nul : un ratio n'existe pas. Même refus qu'en 2.11.
    notEvaluated.push(
      `Marge : non évaluée — aucun chiffre d'affaires retenu sur ${month} (il faut un ` +
        "dénominateur pour un pourcentage).",
    );
  } else {
    let cumulativeCost = 0;
    const cumulativeMissing: string[] = [];
    for (const level of LEVEL_ORDER) {
      for (const category of COST_CATEGORIES.filter((entry) => entry.level === level)) {
        const bucket = byCategory.get(category.id);
        if (bucket) cumulativeCost += bucket.amountCents;
        else cumulativeMissing.push(category.label);
      }
      const marginCents = revenueCents - cumulativeCost;
      const marginRatio = marginCents / revenueCents;
      const percent = Math.round(marginRatio * 100);
      const kind = cumulativeMissing.length === 0 ? "complete" : "borne_superieure";
      levels.push({
        level,
        label: LEVEL_LABELS[level],
        costCents: cumulativeCost,
        missingCategories: [...cumulativeMissing],
        marginCents,
        kind,
        marginRatio,
        reason:
          kind === "complete"
            ? `${euros(marginCents)} sur ${euros(revenueCents)} de chiffre d'affaires, ` +
              `soit ${percent} % — tous les postes de ce niveau sont renseignés.`
            : `AU PLUS ${euros(marginCents)} sur ${euros(revenueCents)} de chiffre d'affaires, ` +
              `soit au plus ${percent} %. ${cumulativeMissing.length} poste(s) non ` +
              `renseigné(s) (${cumulativeMissing.join(", ")}) : la marge réelle est ` +
              "forcément INFÉRIEURE.",
      });
    }
  }

  return {
    month,
    rulesVersion: MARGIN_RULES_VERSION,
    revenueCents,
    invoiceCount,
    costs: costLines,
    levels,
    missingCategories: missing.map((category) => ({ id: category.id, label: category.label })),
    notEvaluated,
    excludedCount,
    unusableCount,
    label:
      "Une charge oubliée fait TOUJOURS paraître la marge meilleure qu'elle n'est : " +
      "tant qu'un poste manque, ce chiffre est un plafond, pas un résultat. " +
      "Ne remplace pas votre expert-comptable.",
  };
}
