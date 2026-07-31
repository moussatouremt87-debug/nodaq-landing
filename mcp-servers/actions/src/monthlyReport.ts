import { z } from "zod";
import { EXCLUDED_STATUSES, euroToCents } from "./salesForecast.js";

/*
 * Rapport mensuel + anomalies (ticket 2.11).
 *
 * C'est le premier ticket qui SYNTHÉTISE au lieu d'extraire. Le risque n'est
 * donc plus l'injection ni la fuite — c'est l'AFFIRMATION : un rapport qui
 * décrète « votre marge se dégrade » sur trois factures, ou qui signale une
 * anomalie qui n'en est pas une, détruit la confiance plus sûrement qu'un
 * rapport vide.
 *
 * D'où la règle du module : **une anomalie est un écart MESURÉ**, pas un
 * jugement. Chacune porte la valeur observée, la valeur de référence, le
 * seuil franchi et l'échantillon sur lequel elle est calculée. Le modèle ne
 * décide jamais qu'il y a anomalie : il met en français des chiffres déjà
 * établis ici.
 *
 * Trois refus, testés :
 *  - **historique insuffisant = règle NON évaluée**, et le trou est dit. Une
 *    baisse « vs les 3 mois précédents » quand il n'y a qu'un mois est une
 *    invention.
 *  - **dénominateur nul = aucune comparaison.** « +∞ % » n'est pas un
 *    constat.
 *  - **médiane, pas moyenne**, pour repérer une facture inhabituelle : une
 *    seule grosse facture ferait bouger la moyenne et se masquerait
 *    elle-même.
 */

/** Seuils versionnés — un seuil qui bouge change ce qui est signalé. */
export const ANOMALY_RULES_VERSION = "2026-07-31";

export const ANOMALY_THRESHOLDS = {
  /** Baisse du CA vs moyenne des mois précédents (part, ex. 0.2 = −20 %). */
  revenueDropRatio: 0.2,
  /** Mois d'historique nécessaires pour comparer un mois à sa référence. */
  minHistoryMonths: 3,
  /** Multiple de la médiane au-delà duquel une facture est « inhabituelle ». */
  unusualInvoiceFactor: 3,
  /** Factures nécessaires avant de parler de facture inhabituelle. */
  minInvoicesForMedian: 6,
  /** Part du CA du mois concentrée sur un seul client. */
  customerConcentrationRatio: 0.4,
  /** Hausse de l'encours échu vs le mois précédent. */
  overdueGrowthRatio: 0.3,
} as const;

/** Facture — même forme que l'interface facturier (Pennylane/démo/FEC). */
export const ReportInvoice = z.object({
  amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
  date: z.string().nullish(),
  status: z.string().nullish(),
  customer: z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().nullish(),
    })
    .nullish()
    .catch(null),
});
export type ReportInvoice = z.infer<typeof ReportInvoice>;

export type AnomalyKind =
  | "ca_en_baisse"
  | "facture_inhabituelle"
  | "concentration_client"
  | "impayes_en_hausse";

export interface Anomaly {
  kind: AnomalyKind;
  /** Valeur constatée (centimes ou part selon la règle). */
  observed: number;
  /** Valeur de référence à laquelle elle est comparée. */
  reference: number;
  /** Seuil franchi — affiché, pour que le verdict soit contestable. */
  threshold: number;
  /** Taille de l'échantillon derrière la comparaison. */
  sampleSize: number;
  /** Phrase française CHIFFRÉE : le modèle n'a rien à inventer. */
  reason: string;
}

export interface MonthlyReport {
  /** Mois analysé, "YYYY-MM". */
  month: string;
  rulesVersion: string;
  revenueCents: number;
  invoiceCount: number;
  /** Encours échu à la fin du mois (factures en retard). */
  overdueCents: number;
  overdueCount: number;
  /** Moyenne des mois de référence, `null` sans historique suffisant. */
  referenceRevenueCents: number | null;
  referenceMonths: number;
  /** Meilleur client du mois — owner-only par construction (dataset entier). */
  topCustomer: { name: string | null; totalCents: number; share: number } | null;
  anomalies: Anomaly[];
  /** Règles NON évaluées faute de données — dites, jamais tues. */
  notEvaluated: string[];
  /** Factures ignorées (date ou montant illisible, devise étrangère). */
  unusableCount: number;
  /** Brouillons, devis et factures annulées — écartés du CA, jamais tus. */
  excludedCount: number;
  label: string;
}

const MONTH = /^\d{4}-\d{2}$/;

/**
 * Montant -> centimes, avec le parseur STRICT de la prévision (3.1) : un
 * montant malformé est écarté, jamais tronqué en un chiffre d'affaires faux.
 * Partagé volontairement — deux lectures différentes du même montant sur deux
 * écrans du même produit seraient un défaut, pas un détail.
 */
function centsOf(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return euroToCents(value);
}

function monthOf(date: unknown): string | null {
  if (typeof date !== "string" || date.length < 7) return null;
  const month = date.slice(0, 7);
  return MONTH.test(month) ? month : null;
}

/** Mois précédent d'un "YYYY-MM". */
export function previousMonthKey(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, "0")}`;
}

/**
 * Nombre de mois entre `month` et `reference` (positif = passé), `null` si
 * l'un des deux n'est pas un "YYYY-MM". Sert à borner la lecture ET à refuser
 * un mois futur ou en cours.
 */
export function monthsBetween(month: string, reference: string): number | null {
  if (!MONTH.test(month) || !MONTH.test(reference)) return null;
  const months = (key: string): number =>
    Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
  return months(reference) - months(month);
}

/** Profondeur de lecture maximale d'un rapport mensuel. */
export const MAX_REPORT_AGE_MONTHS = 24;

/** Médiane — robuste à une valeur extrême, contrairement à la moyenne. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
    : (sorted[middle] as number);
}

const euros = (cents: number): string =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })
    .format(cents / 100);

/**
 * Construit le rapport d'un mois. PURE : aucune I/O, aucune horloge.
 *
 * `invoices` doit couvrir le mois analysé ET son historique — le module ne va
 * rien chercher, et ne suppose jamais qu'un mois absent vaut zéro.
 */
export function buildMonthlyReport(
  invoices: readonly ReportInvoice[],
  month: string,
): MonthlyReport {
  if (!MONTH.test(month)) throw new Error("invalid month");

  const byMonth = new Map<string, { cents: number; count: number }>();
  const monthInvoices: { cents: number; customerId: string; customerName: string | null }[] = [];
  let unusableCount = 0;
  let excludedCount = 0;
  let overdueCents = 0;
  let overdueCount = 0;
  let previousOverdueCents = 0;
  const previous = previousMonthKey(month);

  for (const invoice of invoices) {
    // Brouillon, devis ou facture annulée : ce n'est pas une vente. Écarté
    // AVANT toute agrégation, avec la même liste que la prévision (3.1).
    if (invoice.status && EXCLUDED_STATUSES.has(invoice.status)) {
      excludedCount += 1;
      continue;
    }
    const cents = centsOf(invoice.amount);
    const invoiceMonth = monthOf(invoice.date);
    const currency = (invoice.currency ?? "EUR").toUpperCase();
    // Devise étrangère : comptée à part, JAMAIS convertie à un taux inventé.
    if (cents === null || invoiceMonth === null || currency !== "EUR") {
      unusableCount += 1;
      continue;
    }
    const bucket = byMonth.get(invoiceMonth) ?? { cents: 0, count: 0 };
    bucket.cents += cents;
    bucket.count += 1;
    byMonth.set(invoiceMonth, bucket);

    if (invoiceMonth === month) {
      monthInvoices.push({
        cents,
        customerId: invoice.customer?.id ?? "",
        customerName: invoice.customer?.name ?? null,
      });
      if (invoice.status === "late") {
        overdueCents += cents;
        overdueCount += 1;
      }
    }
    if (invoiceMonth === previous && invoice.status === "late") previousOverdueCents += cents;
  }

  const current = byMonth.get(month) ?? { cents: 0, count: 0 };
  const anomalies: Anomaly[] = [];
  const notEvaluated: string[] = [];

  // --- CA en baisse vs la moyenne des mois précédents --------------------
  const history: number[] = [];
  let cursor = previous;
  for (let index = 0; index < ANOMALY_THRESHOLDS.minHistoryMonths; index += 1) {
    const bucket = byMonth.get(cursor);
    if (bucket) history.push(bucket.cents);
    cursor = previousMonthKey(cursor);
  }
  const referenceRevenueCents =
    history.length >= ANOMALY_THRESHOLDS.minHistoryMonths
      ? Math.round(history.reduce((sum, value) => sum + value, 0) / history.length)
      : null;

  if (referenceRevenueCents === null) {
    notEvaluated.push(
      `Baisse du chiffre d'affaires : non évaluée — il faut ${ANOMALY_THRESHOLDS.minHistoryMonths} ` +
        `mois d'historique, ${history.length} disponible(s).`,
    );
  } else if (referenceRevenueCents === 0) {
    // Dénominateur nul : « +∞ % » n'est pas un constat.
    notEvaluated.push(
      "Baisse du chiffre d'affaires : non évaluée — les mois de référence sont à zéro.",
    );
  } else {
    const drop = (referenceRevenueCents - current.cents) / referenceRevenueCents;
    if (drop >= ANOMALY_THRESHOLDS.revenueDropRatio) {
      anomalies.push({
        kind: "ca_en_baisse",
        observed: current.cents,
        reference: referenceRevenueCents,
        threshold: ANOMALY_THRESHOLDS.revenueDropRatio,
        sampleSize: history.length,
        reason:
          `${euros(current.cents)} ce mois contre ${euros(referenceRevenueCents)} en moyenne sur ` +
          `les ${history.length} mois précédents, soit −${Math.round(drop * 100)} % ` +
          `(seuil d'alerte : −${Math.round(ANOMALY_THRESHOLDS.revenueDropRatio * 100)} %).`,
      });
    }
  }

  // --- Facture inhabituelle (médiane sur tout l'historique fourni) --------
  // Même population que le CA : un brouillon n'entre pas dans la médiane, sinon
  // la référence n'est pas celle des factures auxquelles on la compare.
  const allAmounts = invoices
    .filter((invoice) => !(invoice.status && EXCLUDED_STATUSES.has(invoice.status)))
    .map((invoice) => centsOf(invoice.amount))
    .filter((value): value is number => value !== null);
  const medianAmount = median(allAmounts);
  if (allAmounts.length < ANOMALY_THRESHOLDS.minInvoicesForMedian || medianAmount === null) {
    notEvaluated.push(
      `Facture inhabituelle : non évaluée — il faut ${ANOMALY_THRESHOLDS.minInvoicesForMedian} ` +
        `factures, ${allAmounts.length} disponible(s).`,
    );
  } else if (medianAmount > 0) {
    const biggest = monthInvoices.reduce<number>((max, entry) => Math.max(max, entry.cents), 0);
    if (biggest >= medianAmount * ANOMALY_THRESHOLDS.unusualInvoiceFactor) {
      anomalies.push({
        kind: "facture_inhabituelle",
        observed: biggest,
        reference: medianAmount,
        threshold: ANOMALY_THRESHOLDS.unusualInvoiceFactor,
        sampleSize: allAmounts.length,
        reason:
          `Une facture de ${euros(biggest)} ce mois, contre une médiane de ` +
          `${euros(medianAmount)} sur ${allAmounts.length} factures ` +
          `(seuil : ×${ANOMALY_THRESHOLDS.unusualInvoiceFactor}). À vérifier, pas forcément une erreur.`,
      });
    }
  }

  // --- Concentration client ----------------------------------------------
  let topCustomer: MonthlyReport["topCustomer"] = null;
  if (current.cents > 0) {
    const perCustomer = new Map<string, { name: string | null; cents: number }>();
    for (const entry of monthInvoices) {
      // Facture sans client rattaché : comptée au CA, jamais attribuée.
      if (!entry.customerId) continue;
      const bucket = perCustomer.get(entry.customerId) ?? { name: entry.customerName, cents: 0 };
      bucket.cents += entry.cents;
      perCustomer.set(entry.customerId, bucket);
    }
    const best = [...perCustomer.values()].sort((a, b) => b.cents - a.cents)[0];
    if (best) {
      const share = best.cents / current.cents;
      topCustomer = { name: best.name, totalCents: best.cents, share };
      if (share >= ANOMALY_THRESHOLDS.customerConcentrationRatio) {
        anomalies.push({
          kind: "concentration_client",
          observed: best.cents,
          reference: current.cents,
          threshold: ANOMALY_THRESHOLDS.customerConcentrationRatio,
          sampleSize: perCustomer.size,
          reason:
            `${Math.round(share * 100)} % du chiffre d'affaires du mois vient d'un seul client ` +
            `(${euros(best.cents)} sur ${euros(current.cents)}, ${perCustomer.size} client(s) ` +
            `facturé(s)) — seuil : ${Math.round(ANOMALY_THRESHOLDS.customerConcentrationRatio * 100)} %.`,
        });
      }
    }
  }

  // --- Impayés en hausse --------------------------------------------------
  // Le statut lu est celui d'AUJOURD'HUI, rapporté au mois d'ÉMISSION : une
  // facture récente a eu moins de temps pour tomber en retard, donc le mois
  // courant est structurellement défavorisé. Le biais joue contre l'alerte
  // (jamais en sa faveur) et il est DIT dans la phrase — pas caché.
  if (previousOverdueCents === 0) {
    notEvaluated.push(
      "Hausse des impayés : non évaluée — aucun impayé le mois précédent (pas de référence).",
    );
  } else {
    const growth = (overdueCents - previousOverdueCents) / previousOverdueCents;
    if (growth >= ANOMALY_THRESHOLDS.overdueGrowthRatio) {
      anomalies.push({
        kind: "impayes_en_hausse",
        observed: overdueCents,
        reference: previousOverdueCents,
        threshold: ANOMALY_THRESHOLDS.overdueGrowthRatio,
        sampleSize: overdueCount,
        reason:
          `${euros(overdueCents)} de factures émises ce mois-ci aujourd'hui en retard de ` +
          `paiement (${overdueCount} facture(s)), contre ${euros(previousOverdueCents)} pour ` +
          `le mois précédent, soit +${Math.round(growth * 100)} % ` +
          `(seuil : +${Math.round(ANOMALY_THRESHOLDS.overdueGrowthRatio * 100)} %).`,
      });
    }
  }

  return {
    month,
    rulesVersion: ANOMALY_RULES_VERSION,
    revenueCents: current.cents,
    invoiceCount: current.count,
    overdueCents,
    overdueCount,
    referenceRevenueCents,
    referenceMonths: history.length,
    topCustomer,
    anomalies,
    notEvaluated,
    unusableCount,
    excludedCount,
    label:
      "Chiffres lus dans votre facturier ; chaque anomalie est un écart mesuré " +
      "avec son seuil, pas un jugement — à confirmer avant d'agir.",
  };
}
