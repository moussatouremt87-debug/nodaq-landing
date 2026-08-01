import { z } from "zod";
import { claimableCents, normalizeSaleInvoice, OVERDUE_STATUSES } from "./salesForecast.js";

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
  /** Part non exigible (retenue de garantie 4117, US-8) — 0 si absente. */
  retained_amount: z.union([z.string(), z.number()]).nullish(),
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
  /** Factures du mois rattachées à AUCUN client : comptées au CA, jamais
   * attribuées — elles diluent la part du premier client, donc elles se
   * disent (sinon une vraie concentration passe sous le seuil en silence). */
  unattributedCount: number;
  unattributedCents: number;
  anomalies: Anomaly[];
  /** Règles NON évaluées faute de données — dites, jamais tues. */
  notEvaluated: string[];
  /** Factures ignorées (date ou montant illisible, devise étrangère). */
  unusableCount: number;
  /** Brouillons, devis, avoirs et factures annulées — hors CA, jamais tus. */
  excludedCount: number;
  /** La lecture du facturier a été coupée : des factures peuvent manquer,
   * y compris sur le mois analysé (l'ordre de tri n'est pas contractuel). */
  windowTruncated: boolean;
  label: string;
}

const MONTH = /^\d{4}-\d{2}$/;

/** Décale un "YYYY-MM" de `delta` mois (négatif = vers le passé). */
export function shiftMonthKey(month: string, delta: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Mois précédent d'un "YYYY-MM". */
export function previousMonthKey(month: string): string {
  return shiftMonthKey(month, -1);
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

/**
 * Fenêtre de la médiane, adossée au mois ANALYSÉ (et non à aujourd'hui) : le
 * rapport d'un mois donné doit dire la même chose en juillet et en décembre.
 */
export const MEDIAN_WINDOW_MONTHS = 12;

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
  { windowTruncated = false }: { windowTruncated?: boolean } = {},
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

  // Fenêtre de la médiane : FIXE et adossée au mois analysé, jamais à la date
  // de consultation — sinon le même mois change de verdict selon le jour où on
  // l'ouvre. Bornes calculées une fois.
  const medianWindowStart = shiftMonthKey(month, -(MEDIAN_WINDOW_MONTHS - 1));
  const windowAmounts: number[] = [];

  for (const invoice of invoices) {
    // UNE seule séquence de décisions, partagée avec la prévision (3.1) :
    // brouillon/annulée, avoir, devise étrangère, montant ou date illisible.
    const normalized = normalizeSaleInvoice(invoice);
    if (!normalized.ok) {
      if (normalized.reason === "exclue" || normalized.reason === "non_positif") {
        excludedCount += 1;
      } else {
        unusableCount += 1;
      }
      continue;
    }
    const { cents, month: invoiceMonth } = normalized;
    const bucket = byMonth.get(invoiceMonth) ?? { cents: 0, count: 0 };
    bucket.cents += cents;
    bucket.count += 1;
    byMonth.set(invoiceMonth, bucket);

    // La médiane est calculée sur la MÊME population que le CA (factures
    // retenues), et sur une fenêtre bornée — pas sur tout ce qui a été lu.
    if (invoiceMonth <= month && invoiceMonth >= medianWindowStart) windowAmounts.push(cents);

    const overdue = invoice.status ? OVERDUE_STATUSES.has(invoice.status) : false;
    // L'ENCOURS ÉCHU se compte sur la part exigible : une retenue de garantie
    // (4117, US-8) est due mais pas encore réclamable — la compter ici ferait
    // monter « les impayés » sans qu'un seul client soit en retard, et
    // pousserait à relancer (règle `impayes_en_hausse`). Le CA, lui, garde le
    // montant du marché : c'est bien ce qui a été facturé.
    const claimable = claimableCents(invoice, cents);
    if (invoiceMonth === month) {
      monthInvoices.push({
        cents,
        customerId: invoice.customer?.id ?? "",
        customerName: invoice.customer?.name ?? null,
      });
      if (overdue && claimable > 0) {
        overdueCents += claimable;
        overdueCount += 1;
      }
    }
    if (invoiceMonth === previous && overdue) previousOverdueCents += claimable;
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

  // --- Facture inhabituelle (médiane sur une fenêtre FIXE) ----------------
  const medianAmount = median(windowAmounts);
  if (windowAmounts.length < ANOMALY_THRESHOLDS.minInvoicesForMedian || medianAmount === null) {
    notEvaluated.push(
      `Facture inhabituelle : non évaluée — il faut ${ANOMALY_THRESHOLDS.minInvoicesForMedian} ` +
        `factures sur ${MEDIAN_WINDOW_MONTHS} mois, ${windowAmounts.length} disponible(s).`,
    );
  } else if (medianAmount <= 0) {
    // Médiane nulle : le seuil « ×3 » n'aurait aucun sens. Une règle qui ne
    // s'exécute pas doit se voir, sinon son silence se lit comme un feu vert.
    notEvaluated.push(
      "Facture inhabituelle : non évaluée — la médiane des factures est à zéro.",
    );
  } else {
    const biggest = monthInvoices.reduce<number>((max, entry) => Math.max(max, entry.cents), 0);
    if (biggest >= medianAmount * ANOMALY_THRESHOLDS.unusualInvoiceFactor) {
      anomalies.push({
        kind: "facture_inhabituelle",
        observed: biggest,
        reference: medianAmount,
        threshold: ANOMALY_THRESHOLDS.unusualInvoiceFactor,
        sampleSize: windowAmounts.length,
        reason:
          `Une facture de ${euros(biggest)} ce mois, contre une médiane de ` +
          `${euros(medianAmount)} sur ${windowAmounts.length} factures des ` +
          `${MEDIAN_WINDOW_MONTHS} derniers mois ` +
          `(seuil : ×${ANOMALY_THRESHOLDS.unusualInvoiceFactor}). À vérifier, pas forcément une erreur.`,
      });
    }
  }

  // --- Concentration client ----------------------------------------------
  let topCustomer: MonthlyReport["topCustomer"] = null;
  // Factures sans client rattaché : comptées au CA, JAMAIS attribuées — donc
  // elles diluent la part du premier client. Tues, elles pourraient faire
  // passer une vraie concentration sous le seuil (même traitement qu'en 3.4).
  const unattributed = monthInvoices.filter((entry) => !entry.customerId);
  const unattributedCount = unattributed.length;
  const unattributedCents = unattributed.reduce((sum, entry) => sum + entry.cents, 0);

  if (current.cents <= 0) {
    notEvaluated.push(
      "Concentration client : non évaluée — aucun chiffre d'affaires retenu sur le mois.",
    );
  } else {
    const perCustomer = new Map<string, { name: string | null; cents: number }>();
    for (const entry of monthInvoices) {
      if (!entry.customerId) continue;
      const bucket = perCustomer.get(entry.customerId) ?? { name: entry.customerName, cents: 0 };
      bucket.cents += entry.cents;
      perCustomer.set(entry.customerId, bucket);
    }
    const best = [...perCustomer.values()].sort((a, b) => b.cents - a.cents)[0];
    if (!best) {
      notEvaluated.push(
        `Concentration client : non évaluée — aucune des ${monthInvoices.length} facture(s) du ` +
          "mois n'est rattachée à un client.",
      );
    } else {
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
            `facturé(s)) — seuil : ${Math.round(ANOMALY_THRESHOLDS.customerConcentrationRatio * 100)} %.` +
            (unattributedCount > 0
              ? ` ${unattributedCount} facture(s) (${euros(unattributedCents)}) ne sont ` +
                "rattachées à aucun client : la part réelle peut être plus élevée."
              : ""),
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

  // Fenêtre de lecture tronquée : l'ordre de tri du fournisseur n'est pas
  // contractuel, donc la coupe peut amputer le mois CIBLE lui-même. Les
  // anomalies restent affichées (les taire serait aussi trompeur) mais elles
  // sont MARQUÉES : un écart calculé sur des données incomplètes n'a pas le
  // même poids qu'un écart calculé sur tout le mois.
  if (windowTruncated) {
    const caveat =
      " Attention : la lecture du facturier a été tronquée — des factures " +
      "peuvent manquer, y compris sur le mois analysé.";
    for (const anomaly of anomalies) anomaly.reason += caveat;
    notEvaluated.push(
      "Lecture tronquée : toutes les règles ci-dessus portent sur un historique " +
        "possiblement incomplet.",
    );
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
    unattributedCount,
    unattributedCents,
    anomalies,
    notEvaluated,
    unusableCount,
    excludedCount,
    windowTruncated,
    label:
      "Chiffres lus dans votre facturier ; chaque anomalie est un écart mesuré " +
      "avec son seuil, pas un jugement — à confirmer avant d'agir.",
  };
}
