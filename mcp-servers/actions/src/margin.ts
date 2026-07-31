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
 * la marge) et impossible à confondre avec un résultat complet.
 *
 * La borne est portée par une UNION DISCRIMINÉE : `marginRatio` n'existe que
 * sur un niveau complet, `maxMarginRatio` sur un niveau borné. Un consommateur
 * — écran ou modèle — ne peut donc pas afficher un point là où il n'y a qu'un
 * plafond, même par distraction. (Le commentaire précédent l'affirmait déjà ;
 * le code, lui, exposait un `marginRatio` nu dans les deux cas — l'audit 2.8
 * l'a relevé, et c'est le genre d'écart entre la prose et le code qui coûte le
 * plus cher.)
 */

import { z } from "zod";
import { COST_CATEGORIES, COST_CATEGORY_IDS, UNMAPPED_CATEGORY } from "@nodaq/shared";
import type { CostLevel } from "@nodaq/shared";
import { normalizeSaleInvoice } from "./salesForecast.js";
import type { ReportInvoice } from "./monthlyReport.js";

/** Bump quand la façon de conclure change (pas quand un compte bouge : 2.8). */
export const MARGIN_RULES_VERSION = "2026-07-31";

/** Une charge du mois, quelle que soit sa provenance. */
export const CostEntry = z.object({
  category: z.string(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amountCents: z.number().int(),
  /** `fec` = dérivée d'un import comptable ; `saisi` = déclarée par l'owner. */
  source: z.enum(["fec", "saisi"]),
});
export type CostEntry = z.infer<typeof CostEntry>;

interface MarginLevelBase {
  level: CostLevel;
  label: string;
  /** Total des charges CONNUES de ce niveau (et des niveaux inférieurs). */
  costCents: number;
  /** Postes attendus dont aucune charge n'a été trouvée pour le mois. */
  missingCategories: string[];
  /**
   * Marge en centimes. Sur un niveau borné, c'est un PLAFOND — la vraie marge
   * est forcément plus basse.
   */
  marginCents: number;
  /** Phrase française CHIFFRÉE, déjà qualifiée. Le modèle relaie. */
  reason: string;
}

export type MarginLevel =
  | (MarginLevelBase & { kind: "complete"; marginRatio: number })
  | (MarginLevelBase & { kind: "borne_superieure"; maxMarginRatio: number });

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
  /**
   * Charges de classe 6 qu'aucun poste ne couvre (603 variation des stocks,
   * 600, 608…). Leur simple existence interdit d'annoncer une marge complète :
   * ce sont des charges réelles dont on ignore le niveau.
   */
  unmappedCents: number;
  /** La lecture du facturier a été coupée : le CA — donc le ratio — est partiel. */
  revenueTruncated: boolean;
  /** Aucune charge sur un mois postérieur : la compta du mois n'est peut-être
   * pas arrêtée, donc « tous les postes renseignés » ne vaut pas « complet ». */
  costsPossiblyPartial: boolean;
  /** Règles non évaluées faute de données (ex. aucun CA). */
  notEvaluated: string[];
  excludedCount: number;
  unusableCount: number;
  label: string;
}

// Aligné sur le CHECK SQL et les regex d'API : "2026-13" n'est pas un mois.
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

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
  {
    revenueTruncated = false,
    costsPossiblyPartial = false,
  }: { revenueTruncated?: boolean; costsPossiblyPartial?: boolean } = {},
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

  // Charges du mois par poste. La comptabilité PRIME sur la saisie : un owner
  // qui déclare un poste « non renseigné » puis importe son FEC verrait sinon
  // la charge comptée DEUX fois (audit 2.8). Une seule source par poste, et
  // laquelle est dite.
  const byCategory = new Map<string, { amountCents: number; source: string }>();
  for (const source of ["fec", "saisi"] as const) {
    for (const cost of costs) {
      if (cost.month !== month || cost.source !== source) continue;
      if (cost.category !== UNMAPPED_CATEGORY && !COST_CATEGORY_IDS.includes(cost.category)) {
        continue;
      }
      const existing = byCategory.get(cost.category);
      // `fec` passe en premier : une saisie du même poste est ignorée.
      if (existing && existing.source !== source) continue;
      byCategory.set(cost.category, {
        amountCents: (existing?.amountCents ?? 0) + cost.amountCents,
        source,
      });
    }
  }

  // Charges réelles de niveau INCONNU : elles ne comblent aucun poste, mais
  // elles interdisent d'annoncer un résultat complet.
  const unmappedCents = byCategory.get(UNMAPPED_CATEGORY)?.amountCents ?? 0;
  byCategory.delete(UNMAPPED_CATEGORY);

  const costLines = COST_CATEGORIES.filter((category) => byCategory.has(category.id)).map(
    (category) => {
      const bucket = byCategory.get(category.id);
      return {
        category: category.id,
        label: category.label,
        amountCents: bucket?.amountCents ?? 0,
        source: bucket?.source ?? "",
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
      // Les charges non rattachées sont DÉDUITES au niveau exploitation : ce
      // sont des charges d'exploitation réelles, et les retrancher rapproche
      // le plafond de la vérité. On ne les déduit pas de la marge brute : rien
      // ne dit qu'elles soient des coûts directs.
      const levelCost = level === "exploitation" ? cumulativeCost + unmappedCents : cumulativeCost;
      const marginCents = revenueCents - levelCost;
      const ratio = marginCents / revenueCents;
      const percent = Math.round(ratio * 100);
      const base = {
        level,
        label: LEVEL_LABELS[level],
        costCents: levelCost,
        missingCategories: [...cumulativeMissing],
        marginCents,
      };
      // Un poste manquant OU des charges de niveau inconnu : dans les deux cas
      // la base est incomplète, donc le chiffre est un plafond.
      if (cumulativeMissing.length === 0 && unmappedCents === 0 && !costsPossiblyPartial) {
        levels.push({
          ...base,
          kind: "complete",
          marginRatio: ratio,
          reason:
            `${euros(marginCents)} sur ${euros(revenueCents)} de chiffre d'affaires, ` +
            `soit ${percent} % — tous les postes de ce niveau sont renseignés.`,
        });
      } else {
        const causes: string[] = [];
        if (cumulativeMissing.length > 0) {
          causes.push(
            `${cumulativeMissing.length} poste(s) non renseigné(s) ` +
              `(${cumulativeMissing.join(", ")})`,
          );
        }
        if (unmappedCents !== 0) {
          causes.push(
            `${euros(unmappedCents)} de charges qu'aucun poste ne couvre ` +
              "(variation de stocks, comptes hors catalogue)",
          );
        }
        if (costsPossiblyPartial) {
          // « Les six postes sont peuplés » ne prouve PAS que le mois est
          // arrêté : en PME, des charges arrivent avec un ou deux mois de
          // retard, et le dernier mois d'un FEC s'arrête souvent en plein
          // milieu (audit 2.8).
          causes.push(
            "aucune charge enregistrée sur un mois POSTÉRIEUR : la comptabilité de ce " +
              "mois n'est peut-être pas arrêtée",
          );
        }
        levels.push({
          ...base,
          kind: "borne_superieure",
          maxMarginRatio: ratio,
          reason:
            `AU PLUS ${euros(marginCents)} sur ${euros(revenueCents)} de chiffre d'affaires, ` +
            `soit au plus ${percent} %. ${causes.join(" ; ")} : la marge réelle est ` +
            "forcément INFÉRIEURE.",
        });
      }
    }
    if (revenueTruncated) {
      // Un CA tronqué change le DÉNOMINATEUR : le pourcentage lui-même est
      // douteux, pas seulement la liste des charges.
      notEvaluated.push(
        "Lecture du facturier tronquée : le chiffre d'affaires du mois est " +
          "possiblement partiel, donc le pourcentage aussi.",
      );
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
    unmappedCents,
    revenueTruncated,
    costsPossiblyPartial,
    notEvaluated,
    excludedCount,
    unusableCount,
    label:
      "Une charge oubliée fait TOUJOURS paraître la marge meilleure qu'elle n'est : " +
      "tant qu'un poste manque, ce chiffre est un plafond, pas un résultat. " +
      "Ne remplace pas votre expert-comptable.",
  };
}
