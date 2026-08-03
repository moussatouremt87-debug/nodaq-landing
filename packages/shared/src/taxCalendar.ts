import { IS_RATES } from "./frenchTax.js";

/*
 * Échéancier fiscal & social (ticket 2.9) — CONFIG VERSIONNÉE DATÉE SOURCÉE,
 * même doctrine que frenchTax.ts (2.19), regulatoryWatch.ts (3.7) et
 * rgpdRegister.ts (3.9) : les règles de date sont des DONNÉES sourcées, pas
 * du code en dur dans le moteur.
 *
 * Différence avec la veille réglementaire (3.7), qui pourrait sembler
 * proche : 3.7 dit CE QUI S'IMPOSE à l'entreprise (obligations, échéances de
 * réforme). 2.9 dit QUAND PAYER ET DÉCLARER, mois après mois, en fonction du
 * régime fiscal réel du tenant — et alimente la trésorerie en décaissements
 * DATÉS. L'un est une veille, l'autre un calendrier.
 *
 * Vérifié le 2026-07-31 (textes + portails officiels) :
 * - TVA réel normal : déclaration CA3 et paiement le mois suivant, à une date
 *   comprise entre le 15 et le 24 selon la forme juridique et le numéro
 *   SIREN — la date exacte est celle de l'espace professionnel impots.gouv.
 *   (CGI ann. IV art. 39 ; impots.gouv.fr « dates limites de dépôt »).
 *   NOUS NE L'INVENTONS PAS : la borne basse fait foi comme date « à
 *   préparer pour », et l'imprécision est DITE.
 * - TVA réel simplifié : deux acomptes semestriels (juillet 55 %, décembre
 *   40 % de la TVA due de l'exercice précédent) et une déclaration annuelle
 *   CA12 (CGI art. 287-3 ; service-public.fr).
 * - Franchise en base : aucune déclaration de TVA périodique (CGI art. 293 B).
 * - IS : acomptes 15/03, 15/06, 15/09, 15/12 et dispense sous 3 000 € d'IS
 *   N-1 — repris de frenchTax.ts (CGI art. 1668), JAMAIS redupliqués ici ;
 *   solde le 15 du 4e mois suivant la clôture (CGI ann. III art. 360 bis).
 * - CFE : solde au 15 décembre ; acompte au 15 juin si la CFE N-1 atteint
 *   3 000 € (CGI art. 1679 quinquies ; impots.gouv.fr).
 * - DSN : dépôt le 5 du mois suivant pour les employeurs d'au moins
 *   50 salariés dont la paie est versée le mois même, le 15 sinon
 *   (CSS art. R243-6 ; urssaf.fr, net-entreprises.fr).
 * - Cotisations URSSAF trimestrielles (option ouverte aux employeurs de
 *   moins de 11 salariés) : 15/01, 15/04, 15/07, 15/10 (urssaf.fr).
 *
 * NON couvert volontairement en V1, et c'est un choix, pas un oubli :
 * la CVAE (calendrier de suppression progressive modifié plusieurs fois par
 * les lois de finances successives — publier une date que nous ne pouvons
 * pas garantir serait pire que de n'en publier aucune) et les taxes
 * sectorielles. Les ajouter = éditer CE fichier, avec la source.
 */

/** Date de vérification du calendrier — à bumper à chaque changement. */
export const TAX_CALENDAR_VERSION = "2026-07-31";

/** Régimes de TVA reconnus. `inconnu` n'est PAS un défaut commode : c'est
 * l'état réel tant que l'owner n'a pas renseigné son régime, et il est dit. */
export const VAT_REGIMES = [
  "inconnu",
  "franchise",
  "reel_simplifie",
  "reel_normal_mensuel",
  "reel_normal_trimestriel",
] as const;
export type VatRegime = (typeof VAT_REGIMES)[number];

export const PAYROLL_PERIODICITIES = ["aucune", "mensuelle", "trimestrielle"] as const;
export type PayrollPeriodicity = (typeof PAYROLL_PERIODICITIES)[number];

export interface TaxProfile {
  vatRegime: VatRegime;
  /** Soumise à l'IS (sinon IR — les acomptes IS ne s'appliquent pas). */
  corporateTaxLiable: boolean;
  /** Mois de clôture de l'exercice (1-12). */
  fiscalYearEndMonth: number;
  payrollPeriodicity: PayrollPeriodicity;
  /** Effectif connu (profil 3.7) — pilote la date de dépôt DSN. */
  headcount: number | null;
}

/** Profil tel qu'il est STOCKÉ : tout est optionnel, rien n'est garanti. */
export interface StoredTaxProfile {
  vatRegime?: string | null;
  corporateTaxLiable?: boolean | null;
  fiscalYearEndMonth?: number | null;
  payrollPeriodicity?: string | null;
  headcountOverride?: number | null;
}

/**
 * Traduit le profil stocké en `TaxProfile` exploitable. PURE.
 *
 * Vit ici, avec le calendrier, parce que deux appelants (l'outil d'agent 2.9 et
 * le brief du matin F5) doivent lire le MÊME échéancier : deux dérivations
 * parallèles du profil, c'est deux calendriers qui divergent sans que rien ne
 * le signale.
 *
 * Un régime non reconnu retombe sur `inconnu` — l'échéancier le DIT (`gaps`)
 * au lieu de proposer les échéances d'un régime supposé. L'effectif suit la
 * règle de 3.7 : déclaré, sinon dérivé de l'équipe active, sinon INCONNU —
 * jamais lu comme zéro.
 */
export function resolveTaxProfile(
  stored: StoredTaxProfile | null | undefined,
  activeStaff: number,
): TaxProfile {
  const vatRegime: VatRegime = (VAT_REGIMES as readonly string[]).includes(stored?.vatRegime ?? "")
    ? (stored?.vatRegime as VatRegime)
    : "inconnu";
  const payrollPeriodicity: PayrollPeriodicity = (
    PAYROLL_PERIODICITIES as readonly string[]
  ).includes(stored?.payrollPeriodicity ?? "")
    ? (stored?.payrollPeriodicity as PayrollPeriodicity)
    : "aucune";
  return {
    vatRegime,
    corporateTaxLiable: stored?.corporateTaxLiable ?? true,
    fiscalYearEndMonth: stored?.fiscalYearEndMonth ?? 12,
    payrollPeriodicity,
    headcount: stored?.headcountOverride ?? (activeStaff > 0 ? activeStaff : null),
  };
}

export type TaxCategory = "tva" | "is" | "social" | "locale";

export interface TaxObligation {
  id: string;
  label: string;
  category: TaxCategory;
  source: { label: string; url: string };
}

/** Catalogue des obligations récurrentes couvertes en V1. */
export const TAX_OBLIGATIONS = {
  tva_ca3: {
    id: "tva_ca3",
    label: "TVA — déclaration et paiement (CA3)",
    category: "tva",
    source: {
      label: "impots.gouv.fr — dates limites de dépôt des déclarations de TVA",
      url: "https://www.impots.gouv.fr/professionnel/les-dates-limites-de-depot",
    },
  },
  tva_acompte_rsi: {
    id: "tva_acompte_rsi",
    label: "TVA — acompte semestriel (régime simplifié)",
    category: "tva",
    source: {
      label: "CGI art. 287-3 — régime simplifié d'imposition",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042160845",
    },
  },
  tva_ca12: {
    id: "tva_ca12",
    label: "TVA — déclaration annuelle (CA12)",
    category: "tva",
    source: {
      label: "CGI art. 287-3 — déclaration annuelle CA12",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042160845",
    },
  },
  is_acompte: {
    id: "is_acompte",
    label: "Impôt sur les sociétés — acompte trimestriel",
    category: "is",
    source: {
      label: "CGI art. 1668 — acomptes d'IS",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041471762",
    },
  },
  is_solde: {
    id: "is_solde",
    label: "Impôt sur les sociétés — solde",
    category: "is",
    source: {
      label: "CGI ann. III art. 360 bis — liquidation de l'IS",
      url: "https://www.impots.gouv.fr/professionnel/le-paiement-de-limpot-sur-les-societes",
    },
  },
  cfe_solde: {
    id: "cfe_solde",
    label: "Cotisation foncière des entreprises — solde",
    category: "locale",
    source: {
      label: "CGI art. 1679 quinquies — paiement de la CFE",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041464956",
    },
  },
  cfe_acompte: {
    id: "cfe_acompte",
    label: "Cotisation foncière des entreprises — acompte",
    category: "locale",
    source: {
      label: "CGI art. 1679 quinquies — acompte de CFE (si CFE N-1 ≥ 3 000 €)",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041464956",
    },
  },
  dsn_mensuelle: {
    id: "dsn_mensuelle",
    label: "DSN — déclaration sociale nominative et cotisations",
    category: "social",
    source: {
      label: "CSS art. R243-6 — exigibilité des cotisations",
      url: "https://www.urssaf.fr/accueil/employeur/declarer-payer/declarer-cotisations.html",
    },
  },
  urssaf_trimestrielle: {
    id: "urssaf_trimestrielle",
    label: "URSSAF — cotisations trimestrielles",
    category: "social",
    source: {
      label: "urssaf.fr — périodicité trimestrielle (moins de 11 salariés)",
      url: "https://www.urssaf.fr/accueil/employeur/declarer-payer/declarer-cotisations.html",
    },
  },
} satisfies Record<string, TaxObligation>;

/** Effectif à partir duquel la DSN est due le 5 (au lieu du 15). */
export const DSN_EARLY_FILING_HEADCOUNT = 50;

/** Borne basse de la fenêtre de dépôt CA3 (la date exacte dépend du SIREN). */
const CA3_WINDOW = { from: 15, to: 24 } as const;

/**
 * Largeur de l'incertitude, en jours, sur une date `dateIsApproximate`.
 *
 * La date rendue est la borne BASSE de la fenêtre légale ; la vraie date se
 * situe quelque part dans les jours qui suivent. Un aval qui déclare « en
 * retard » doit attendre cette marge : annoncer une pénalité qui n'existe pas
 * coûte plus cher que de la signaler un jour trop tard.
 */
export const APPROXIMATE_DUE_DATE_SLACK_DAYS = CA3_WINDOW.to - CA3_WINDOW.from;

export interface TaxOccurrence {
  obligationId: string;
  label: string;
  category: TaxCategory;
  /** "YYYY-MM-DD" — date à préparer pour (voir `dateIsApproximate`). */
  dueDate: string;
  /** Période concernée, en clair ("mars 2026", "exercice 2025"). */
  period: string;
  /** Pourquoi CETTE date : la règle appliquée, en clair. */
  basis: string;
  /**
   * `true` quand la date exacte dépend d'un paramètre que nous n'avons pas
   * (numéro SIREN pour la CA3). La date affichée est alors la borne BASSE de
   * la fenêtre légale — jamais une date inventée présentée comme certaine.
   */
  dateIsApproximate: boolean;
  source: { label: string; url: string };
}

export interface TaxSchedule {
  rulesVersion: string;
  from: string;
  to: string;
  occurrences: TaxOccurrence[];
  /** Ce que le profil ne permet pas de calculer — dit, jamais deviné. */
  gaps: string[];
}

const MONTH_NAMES = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Mois précédent, en (année, mois) — la période déclarée en CA3. */
function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/**
 * Date du solde d'IS pour l'exercice clos au mois `endMonth` de `year`.
 *
 * Règle générale : le 15 du 4e mois suivant la clôture. Exception EXPRESSE
 * pour l'exercice clos au 31 décembre, dont le solde est reporté au 15 mai
 * suivant (CGI ann. III art. 360 bis) — appliquer la règle générale y
 * donnerait le 15 avril, soit un mois trop tôt.
 */
export function corporateTaxBalanceDate(endMonth: number, year: number): string {
  if (endMonth === 12) return iso(year + 1, 5, 15);
  const raw = endMonth + 4;
  return raw > 12 ? iso(year + 1, raw - 12, 15) : iso(year, raw, 15);
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(value: string, name: string): void {
  if (!DAY_ONLY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`invalid ${name}`);
  }
}

/**
 * Construit l'échéancier sur une fenêtre. Fonction PURE : mêmes entrées,
 * mêmes sorties, aucune I/O, aucune horloge implicite.
 *
 * Elle ne produit AUCUN montant : le calendrier dit quand, pas combien. Un
 * montant n'apparaît que s'il a été déclaré par l'humain (table
 * `tax_deadlines`) — dériver une TVA due depuis le facturier supposerait une
 * comptabilité que nous n'avons pas (même refus qu'en e-reporting, 2.4).
 */
export function buildTaxSchedule(profile: TaxProfile, from: string, to: string): TaxSchedule {
  assertDay(from, "from");
  assertDay(to, "to");
  if (to < from) throw new Error("invalid window");

  const occurrences: TaxOccurrence[] = [];
  const gaps: string[] = [];

  const push = (occurrence: TaxOccurrence): void => {
    if (occurrence.dueDate >= from && occurrence.dueDate <= to) occurrences.push(occurrence);
  };

  const startYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));

  // --- TVA ---------------------------------------------------------------
  if (profile.vatRegime === "inconnu") {
    gaps.push(
      "Régime de TVA non renseigné : aucune échéance de TVA n'est proposée " +
        "(elles dépendent entièrement du régime).",
    );
  }
  for (let year = startYear; year <= endYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      if (profile.vatRegime === "reel_normal_mensuel") {
        const period = previousMonth(year, month);
        push({
          ...TAX_OBLIGATIONS.tva_ca3,
          obligationId: "tva_ca3",
          dueDate: iso(year, month, CA3_WINDOW.from),
          period: `${MONTH_NAMES[period.month - 1]} ${period.year}`,
          basis:
            `Régime réel normal, déclaration mensuelle : dépôt entre le ` +
            `${CA3_WINDOW.from} et le ${CA3_WINDOW.to} du mois suivant selon votre SIREN.`,
          dateIsApproximate: true,
        });
      } else if (profile.vatRegime === "reel_normal_trimestriel" && month % 3 === 1) {
        const quarterEnd = previousMonth(year, month);
        push({
          ...TAX_OBLIGATIONS.tva_ca3,
          obligationId: "tva_ca3",
          dueDate: iso(year, month, CA3_WINDOW.from),
          period: `trimestre clos en ${MONTH_NAMES[quarterEnd.month - 1]} ${quarterEnd.year}`,
          basis:
            `Régime réel normal, déclaration trimestrielle : dépôt entre le ` +
            `${CA3_WINDOW.from} et le ${CA3_WINDOW.to} du mois suivant le trimestre.`,
          dateIsApproximate: true,
        });
      }
    }

    if (profile.vatRegime === "reel_simplifie") {
      for (const [month, share] of [
        [7, "55 %"],
        [12, "40 %"],
      ] as const) {
        push({
          ...TAX_OBLIGATIONS.tva_acompte_rsi,
          obligationId: "tva_acompte_rsi",
          dueDate: iso(year, month, 15),
          period: `${MONTH_NAMES[month - 1]} ${year}`,
          basis: `Régime simplifié : acompte de ${share} de la TVA due de l'exercice précédent.`,
          dateIsApproximate: false,
        });
      }
      // CA12 : dans les 3 mois de la clôture (exercice décalé), sinon en mai.
      const ca12Month = profile.fiscalYearEndMonth === 12 ? 5 : profile.fiscalYearEndMonth + 3;
      if (ca12Month <= 12) {
        push({
          ...TAX_OBLIGATIONS.tva_ca12,
          obligationId: "tva_ca12",
          dueDate: iso(year, ca12Month, 15),
          period: `exercice clos en ${MONTH_NAMES[profile.fiscalYearEndMonth - 1]}`,
          basis:
            profile.fiscalYearEndMonth === 12
              ? "Régime simplifié, exercice civil : déclaration annuelle CA12 déposée en mai."
              : "Régime simplifié : déclaration annuelle CA12 dans les 3 mois de la clôture.",
          dateIsApproximate: true,
        });
      }
    }
  }

  // --- Impôt sur les sociétés -------------------------------------------
  // Les dates d'acompte viennent de frenchTax.ts (2.19) : une seule source.
  if (profile.corporateTaxLiable) {
    // Depuis l'année PRÉCÉDENTE : le solde d'un exercice clos en fin d'année
    // tombe l'année suivante, et c'est souvent l'échéance la plus proche.
    for (let year = startYear - 1; year <= endYear; year += 1) {
      for (const installment of IS_RATES.installmentDates) {
        push({
          ...TAX_OBLIGATIONS.is_acompte,
          obligationId: "is_acompte",
          dueDate: iso(year, installment.month, installment.day),
          period: `acompte du ${installment.day} ${MONTH_NAMES[installment.month - 1]} ${year}`,
          basis:
            `Acompte trimestriel d'IS (CGI 1668). Dispense si l'IS de l'exercice ` +
            `précédent est inférieur à ${IS_RATES.installmentExemptionEur} €.`,
          dateIsApproximate: false,
        });
      }
      // Solde de l'exercice clos DANS l'année `year` : il tombe l'année
      // suivante quand la clôture est tardive, d'où la boucle qui commence un
      // an avant la fenêtre (sinon le solde de l'exercice précédent, qui est
      // l'échéance la plus proche, serait tout simplement absent).
      const solde = corporateTaxBalanceDate(profile.fiscalYearEndMonth, year);
      push({
        ...TAX_OBLIGATIONS.is_solde,
        obligationId: "is_solde",
        dueDate: solde,
        period: `exercice clos en ${MONTH_NAMES[profile.fiscalYearEndMonth - 1]} ${year}`,
        basis:
          profile.fiscalYearEndMonth === 12
            ? "Solde d'IS : le 15 mai suivant, pour un exercice clos au 31 décembre."
            : "Solde d'IS : le 15 du 4e mois suivant la clôture de l'exercice.",
        dateIsApproximate: false,
      });
    }
  } else {
    gaps.push(
      "Entreprise déclarée non soumise à l'IS : les acomptes et le solde d'IS " +
        "ne figurent pas à l'échéancier.",
    );
  }

  // --- Cotisation foncière des entreprises -------------------------------
  for (let year = startYear; year <= endYear; year += 1) {
    push({
      ...TAX_OBLIGATIONS.cfe_solde,
      obligationId: "cfe_solde",
      dueDate: iso(year, 12, 15),
      period: `CFE ${year}`,
      basis: "Solde de CFE au 15 décembre (prélèvement le 15, avis en ligne).",
      dateIsApproximate: false,
    });
    push({
      ...TAX_OBLIGATIONS.cfe_acompte,
      obligationId: "cfe_acompte",
      dueDate: iso(year, 6, 15),
      period: `CFE ${year}`,
      basis:
        "Acompte de CFE au 15 juin — dû UNIQUEMENT si votre CFE de l'année " +
        "précédente atteint 3 000 €. Marquez l'échéance « non applicable » sinon.",
      dateIsApproximate: false,
    });
  }

  // --- Social -------------------------------------------------------------
  if (profile.payrollPeriodicity === "aucune") {
    gaps.push(
      "Aucune paie déclarée : les échéances sociales (DSN, URSSAF) ne sont pas proposées.",
    );
  }
  if (profile.payrollPeriodicity === "mensuelle") {
    if (profile.headcount === null) {
      gaps.push(
        "Effectif inconnu : la DSN est proposée au 15 (règle des employeurs de " +
          `moins de ${DSN_EARLY_FILING_HEADCOUNT} salariés) — à confirmer.`,
      );
    }
    const day = (profile.headcount ?? 0) >= DSN_EARLY_FILING_HEADCOUNT ? 5 : 15;
    for (let year = startYear; year <= endYear; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const period = previousMonth(year, month);
        push({
          ...TAX_OBLIGATIONS.dsn_mensuelle,
          obligationId: "dsn_mensuelle",
          dueDate: iso(year, month, day),
          period: `paie de ${MONTH_NAMES[period.month - 1]} ${period.year}`,
          basis:
            day === 5
              ? `DSN au 5 du mois suivant (employeur d'au moins ${DSN_EARLY_FILING_HEADCOUNT} salariés).`
              : `DSN au 15 du mois suivant (employeur de moins de ${DSN_EARLY_FILING_HEADCOUNT} salariés).`,
          dateIsApproximate: false,
        });
      }
    }
  }
  if (profile.payrollPeriodicity === "trimestrielle") {
    for (let year = startYear; year <= endYear; year += 1) {
      for (const month of [1, 4, 7, 10]) {
        push({
          ...TAX_OBLIGATIONS.urssaf_trimestrielle,
          obligationId: "urssaf_trimestrielle",
          dueDate: iso(year, month, 15),
          period: `trimestre précédant ${MONTH_NAMES[month - 1]} ${year}`,
          basis:
            "Cotisations URSSAF trimestrielles au 15 (option ouverte aux " +
            "employeurs de moins de 11 salariés).",
          dateIsApproximate: false,
        });
      }
    }
  }

  occurrences.sort((a, b) =>
    a.dueDate === b.dueDate ? a.obligationId.localeCompare(b.obligationId) : a.dueDate < b.dueDate ? -1 : 1,
  );
  return { rulesVersion: TAX_CALENDAR_VERSION, from, to, occurrences, gaps };
}

/** Surcharge humaine sur une occurrence (table `tax_deadlines`). */
export interface TaxDeadlineOverride {
  obligationId: string;
  /** "YYYY-MM-DD". */
  dueDate: string;
  amountCents: number | null;
  status: "prevu" | "paye" | "non_applicable";
  note: string | null;
}

export interface PlannedTaxDeadline extends TaxOccurrence {
  /** Montant DÉCLARÉ par l'humain. `null` = inconnu, jamais estimé. */
  amountCents: number | null;
  status: "prevu" | "paye" | "non_applicable";
  note: string | null;
}

export interface PlannedTaxSchedule extends Omit<TaxSchedule, "occurrences"> {
  deadlines: PlannedTaxDeadline[];
  /**
   * Somme des montants DÉCLARÉS et encore à payer sur la fenêtre. Une
   * échéance sans montant ne contribue pas — c'est la même garde qu'en 2.19
   * (amortissement ≠ décaissement) : ce qui n'est pas chiffré par un humain
   * ne touche jamais la trésorerie.
   */
  plannedOutflowCents: number;
  /** Échéances à payer dont le montant reste inconnu — comptées, jamais tues. */
  unpricedCount: number;
}

/**
 * Applique les surcharges humaines au calendrier dérivé. PURE.
 *
 * Le calendrier n'est jamais stocké : il est recalculé à chaque lecture, et
 * seules les décisions humaines (montant, payé, non applicable) persistent.
 * Une surcharge qui ne correspond à aucune occurrence est IGNORÉE — un
 * changement de régime ne doit pas ressusciter une échéance qui n'existe plus.
 */
export function applyTaxOverrides(
  schedule: TaxSchedule,
  overrides: readonly TaxDeadlineOverride[],
): PlannedTaxSchedule {
  const byKey = new Map(
    overrides.map((override) => [`${override.obligationId}|${override.dueDate}`, override]),
  );
  let plannedOutflowCents = 0;
  let unpricedCount = 0;
  const deadlines = schedule.occurrences.map((occurrence) => {
    const override = byKey.get(`${occurrence.obligationId}|${occurrence.dueDate}`);
    const status = override?.status ?? "prevu";
    const amountCents = override?.amountCents ?? null;
    if (status === "prevu") {
      if (amountCents === null) unpricedCount += 1;
      else plannedOutflowCents += amountCents;
    }
    return { ...occurrence, amountCents, status, note: override?.note ?? null };
  });
  const { occurrences: _ignored, ...rest } = schedule;
  return { ...rest, deadlines, plannedOutflowCents, unpricedCount };
}
