/*
 * Règles fiscales françaises — CONFIGURATION VERSIONNÉE ET DATÉE (2.19).
 * Décision non négociable du ticket : les taux, seuils, durées et coefficients
 * sont des DONNÉES sourcées, jamais du code en dur dans le moteur — un taux
 * qui change ne demande pas de re-coder l'amortissement.
 *
 * Vérifié le 2026-07-29 (recherche en ligne + textes) :
 * - IS : taux normal 25 % ; taux réduit 15 % plafonné à 42 500 € de bénéfice
 *   (PME : CA <= 10 M€, capital entièrement libéré et détenu >= 75 % par des
 *   personnes physiques). Sources : CGI art. 219 ; legifiscal.fr (repères
 *   2026). NOTE DE VEILLE : un amendement PLF 2026 propose de porter le
 *   plafond à 100 000 € — NON applicable à la date de vérification.
 * - Acomptes IS : 15/03, 15/06, 15/09, 15/12 ; dispense si IS N-1 < 3 000 €
 *   (CGI art. 1668 ; service-public.fr).
 * - Amortissement dégressif : coefficients 1,25 (3-4 ans), 1,75 (5-6 ans),
 *   2,25 (> 6 ans) — CGI art. 39 A ; réservé à certains biens neufs
 *   (matériel/outillage…), exclu pour les véhicules de tourisme.
 * - Durées d'usage admises (tolérance administrative, BOFiP
 *   BOI-BIC-AMT-10-40-30) : informatique ~3 ans, logiciels 1-3, véhicules
 *   4-5, matériel et outillage 5-10, mobilier 10, agencements 10-20.
 * - Petit équipement : tolérance de passage en CHARGE jusqu'à 500 € HT
 *   (BOFiP BOI-BIC-CHG-20-30-10) — au-delà, immobilisation en principe.
 */

export const FRENCH_TAX_RULES_VERSION = "2026-07-29";

export const IS_RATES = {
  /** Taux normal (CGI 219). */
  standardRate: 0.25,
  /** Taux réduit PME (CGI 219 I-b). */
  reducedRate: 0.15,
  /** Plafond de bénéfice au taux réduit, en euros. */
  reducedRateCapEur: 42_500,
  /** Dispense d'acomptes si l'IS N-1 est sous ce montant (CGI 1668). */
  installmentExemptionEur: 3_000,
  /** Échéances des acomptes trimestriels (mois/jour). */
  installmentDates: [
    { month: 3, day: 15 },
    { month: 6, day: 15 },
    { month: 9, day: 15 },
    { month: 12, day: 15 },
  ],
} as const;

/** Coefficients du dégressif par durée d'amortissement (CGI 39 A). */
export function decliningBalanceCoefficient(durationYears: number): number {
  if (durationYears <= 2) return 1; // dégressif non pertinent sous 3 ans
  if (durationYears <= 4) return 1.25;
  if (durationYears <= 6) return 1.75;
  return 2.25;
}

/** Catégories d'immobilisations V1 et durées d'usage admises (en mois). */
export const ASSET_CATEGORIES = {
  informatique: { label: "Matériel informatique", defaultMonths: 36, decliningAllowed: true },
  logiciel: { label: "Logiciel", defaultMonths: 24, decliningAllowed: false },
  vehicule: { label: "Véhicule", defaultMonths: 60, decliningAllowed: false },
  materiel: { label: "Matériel et outillage", defaultMonths: 84, decliningAllowed: true },
  mobilier: { label: "Mobilier", defaultMonths: 120, decliningAllowed: false },
  agencement: { label: "Agencements et installations", defaultMonths: 180, decliningAllowed: false },
} as const;
export type AssetCategory = keyof typeof ASSET_CATEGORIES;

/** Seuil de tolérance charge/immobilisation, en centimes HT. */
export const CAPITALIZATION_THRESHOLD_CENTS = 50_000;
