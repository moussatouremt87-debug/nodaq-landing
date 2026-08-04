/*
 * Regulatory watch (ticket 3.7) — same doctrine as frenchTax.ts (2.19): the
 * catalog of French SME obligations is a VERSIONED, DATED, SOURCED config —
 * never scattered magic values, never a scraped feed presented as law. A
 * pure matcher derives which obligations apply to a tenant profile (business
 * vertical + headcount) with an explained, figure-backed reason for every
 * inclusion. General information, NOT legal advice — the output label says
 * so permanently. Live external sources (Légifrance/JO feeds) are a future
 * ticket; updating THIS file (with sources) is the V1 update path.
 */

/** Catalog snapshot date — bump on every rule change. */
export const REGULATORY_WATCH_VERSION = "2026-08-04";

/*
 * Verticals now live in `verticalPacks.ts` (ticket 4.2): one vertical = one
 * data file. This module CONSUMES the list, it no longer owns it — an
 * obligation is scoped by trade, but the trades themselves are a product
 * decision, not a regulatory one.
 */
import type { Vertical } from "./verticalPacks.js";

export interface RegulatoryItem {
  id: string;
  title: string;
  category: "fiscal" | "social" | "rgpd" | "consommation" | "environnement" | "assurance";
  /** French, self-contained description of the obligation. */
  obligation: string;
  source: { label: string; url: string };
  /** Absent = applies to every vertical. */
  verticals?: readonly Vertical[];
  /** Headcount threshold (inclusive). Absent = no headcount condition. */
  minHeadcount?: number;
  /** One-shot compliance deadline "YYYY-MM-DD" (e.g. e-invoicing phases). */
  deadline?: string;
  /** Yearly recurring deadline (e.g. index égalité, March 1st). */
  recurring?: { month: number; day: number };
}

/**
 * Curated French SME obligations. Every entry carries its legal source —
 * verified against the cited texts at REGULATORY_WATCH_VERSION date.
 */
export const REGULATORY_ITEMS: readonly RegulatoryItem[] = [
  {
    id: "facture-electronique-reception",
    title: "Facturation électronique — réception obligatoire",
    category: "fiscal",
    obligation:
      "Toutes les entreprises assujetties à la TVA doivent pouvoir RECEVOIR des factures " +
      "électroniques via une plateforme agréée (PDP) ou le portail public au 1er septembre 2026.",
    source: {
      label: "Loi de finances 2024, art. 91",
      url: "https://www.legifrance.gouv.fr/jorf/article_jo/JORFARTI000048727345",
    },
    deadline: "2026-09-01",
  },
  {
    id: "facture-electronique-emission",
    title: "Facturation électronique — émission (PME/TPE)",
    category: "fiscal",
    obligation:
      "Les PME, TPE et micro-entreprises devront ÉMETTRE leurs factures au format " +
      "électronique au 1er septembre 2027 (grandes entreprises et ETI : 1er septembre 2026).",
    source: {
      label: "Loi de finances 2024, art. 91",
      url: "https://www.legifrance.gouv.fr/jorf/article_jo/JORFARTI000048727345",
    },
    deadline: "2027-09-01",
  },
  {
    id: "rgpd-registre",
    title: "RGPD — registre des activités de traitement",
    category: "rgpd",
    obligation:
      "Tenir un registre des traitements de données personnelles (clients, salariés, " +
      "prospects) et le tenir à jour ; il est exigé lors de tout contrôle CNIL. La " +
      "dérogation « moins de 250 salariés » (art. 30 §5) ne joue quasi jamais : elle " +
      "tombe dès qu'un traitement n'est pas occasionnel (paie, fichier clients).",
    source: {
      label: "RGPD, art. 30",
      url: "https://www.cnil.fr/fr/RGPD-le-registre-des-activites-de-traitement",
    },
  },
  {
    id: "duerp",
    title: "Document unique d'évaluation des risques (DUERP)",
    category: "social",
    obligation:
      "Tout employeur d'au moins un salarié doit établir et tenir à jour le document " +
      "unique d'évaluation des risques professionnels.",
    source: {
      label: "Code du travail, art. R4121-1",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000045211527",
    },
    minHeadcount: 1,
  },
  {
    id: "cse",
    title: "Comité social et économique (CSE)",
    category: "social",
    obligation:
      "Mise en place d'un CSE obligatoire dès 11 salariés (effectif atteint pendant " +
      "12 mois consécutifs) : organisation d'élections professionnelles.",
    source: {
      label: "Code du travail, art. L2311-2",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000035609788",
    },
    minHeadcount: 11,
  },
  {
    id: "oeth",
    title: "Obligation d'emploi de travailleurs handicapés (OETH)",
    category: "social",
    obligation:
      "À partir de 20 salariés, employer des travailleurs handicapés à hauteur de 6 % " +
      "de l'effectif (ou verser une contribution) ; déclaration via la DSN.",
    source: {
      label: "Code du travail, art. L5212-2",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000037385858",
    },
    minHeadcount: 20,
  },
  {
    id: "index-egalite",
    title: "Index de l'égalité professionnelle",
    category: "social",
    obligation:
      "À partir de 50 salariés, calculer et publier chaque année l'index de l'égalité " +
      "professionnelle femmes-hommes avant le 1er mars.",
    source: {
      label: "Code du travail, art. L1142-8",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000037379600",
    },
    minHeadcount: 50,
    recurring: { month: 3, day: 1 },
  },
  {
    id: "reglement-interieur",
    title: "Règlement intérieur",
    category: "social",
    obligation:
      "Un règlement intérieur écrit est obligatoire dans les entreprises d'au moins " +
      "50 salariés (hygiène, sécurité, discipline).",
    source: {
      label: "Code du travail, art. L1311-2",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000038610270",
    },
    minHeadcount: 50,
  },
  {
    id: "tri-biodechets",
    title: "Tri à la source des biodéchets",
    category: "environnement",
    obligation:
      "Depuis le 1er janvier 2024, tous les professionnels doivent trier leurs " +
      "biodéchets à la source (loi AGEC), quel que soit le volume produit.",
    source: {
      label: "Loi AGEC, art. 88 (code de l'environnement L541-21-1)",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041599099",
    },
  },
  {
    id: "garantie-decennale",
    title: "Assurance de responsabilité décennale",
    category: "assurance",
    obligation:
      "Toute entreprise dont la responsabilité décennale peut être engagée sur des " +
      "travaux de construction doit être couverte par une assurance décennale AVANT " +
      "l'ouverture de chantier.",
    source: {
      label: "Code des assurances, art. L241-1",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006795171",
    },
    /*
     * Étendue aux métiers de travaux du pivot (4.2). Le sens de l'erreur
     * commande : ne pas rappeler la décennale à qui la doit est bien pire que
     * la rappeler à qui ne la doit pas — son absence est un délit (code des
     * assurances, art. L243-3), le rappel de trop se lit et s'ignore. Le texte
     * de l'obligation porte d'ailleurs sa propre nuance (« dont la
     * responsabilité décennale PEUT être engagée »).
     *
     * LE CRITÈRE N'EST PAS « POSE DES BRIQUES ». Une première version excluait
     * `services_projet` au motif qu'il « ne construit pas d'ouvrage » — c'est
     * précisément le critère que l'art. 1792-1 1° du code civil écarte : est
     * réputé constructeur « tout architecte, entrepreneur, TECHNICIEN ou autre
     * personne liée au maître de l'ouvrage par un contrat de louage
     * d'ouvrage ». Un maître d'œuvre, un bureau d'études ou un économiste de
     * la construction doit la décennale sans toucher une truelle. Le critère
     * retenu est donc le LIEN CONTRACTUEL avec un maître de l'ouvrage.
     *
     * - `batiment`, `industrie_btp` : sans discussion.
     * - `paysage` : murs de soutènement, terrasses et dallages sont des
     *   ouvrages.
     * - `maintenance` : le cas le plus discutable (la jurisprudence renvoie
     *   souvent les équipements installés sur existant à la responsabilité
     *   contractuelle de droit commun) — inclus au nom de l'asymétrie, et il
     *   faut alors inclure `services_projet` pour la même raison.
     * - `services_projet` : recouvre la maîtrise d'œuvre et les bureaux
     *   d'études, expressément visés par l'art. 1792-1 1°.
     * - `evenementiel` : exclu — chapiteaux, scènes et structures démontables
     *   ne sont pas des ouvrages.
     *
     * Les verticaux de l'ANCIEN découpage ne sont pas re-scopés ici : `services`
     * y est un fourre-tout indifférencié (coiffeur et bureau d'études au même
     * endroit), et rescoper une segmentation qu'on ne propose plus dépasse ce
     * ticket. `industrie_btp` garde ce qu'il avait.
     */
    verticals: ["batiment", "paysage", "maintenance", "services_projet", "industrie_btp"],
  },
  {
    id: "information-prix",
    title: "Information du consommateur sur les prix",
    category: "consommation",
    obligation:
      "Affichage obligatoire des prix TTC (étiquetage, vitrine, rayons) et information " +
      "loyale du consommateur avant l'achat.",
    source: {
      label: "Code de la consommation, art. L112-1",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032227213",
    },
    verticals: ["retail", "negoce"],
  },
  {
    id: "mediation-consommation",
    title: "Médiateur de la consommation",
    category: "consommation",
    obligation:
      "Tout professionnel vendant à des consommateurs (y compris travaux chez des " +
      "particuliers) doit adhérer à un dispositif de médiation de la consommation et " +
      "en informer ses clients. Les entreprises 100 % B2B ne sont pas concernées.",
    source: {
      label: "Code de la consommation, art. L612-1",
      url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032224806",
    },
  },
] as const;

export interface ComplianceProfile {
  vertical: Vertical;
  /** Effective headcount — null when unknown (never assumed 0). */
  headcount: number | null;
  /**
   * Where the figure comes from: "declare" = owner-declared (trusted for
   * exclusions), "equipe" = derived from active staff records — possibly
   * PARTIAL input, so it can never silently exclude an obligation.
   */
  headcountSource?: "declare" | "equipe";
}

export interface RegulatoryMatch extends RegulatoryItem {
  /** "oui" when all conditions verified; "peut_etre" when headcount unknown. */
  applies: "oui" | "peut_etre";
  status: "echeance_proche" | "a_venir" | "en_vigueur";
  /** Next relevant deadline (fixed or next recurring occurrence), if any. */
  nextDeadline: string | null;
  /** Days until nextDeadline — null when none or already past. */
  daysUntil: number | null;
  /** French, self-contained applicability justification. */
  reason: string;
}

export interface RegulatoryWatchResult {
  version: string;
  matches: RegulatoryMatch[];
  label: "information générale à date du catalogue — ne remplace pas un conseil juridique";
}

/** Deadlines within this window are flagged "echeance_proche". */
const SOON_DAYS = 90;
const DAY_MS = 86_400_000;

function isoToUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Next deadline for an item: fixed date, or next yearly occurrence. */
function nextDeadline(item: RegulatoryItem, now: Date): string | null {
  if (item.deadline) return item.deadline;
  if (item.recurring) {
    const year = now.getUTCFullYear();
    const thisYear = `${year}-${pad(item.recurring.month)}-${pad(item.recurring.day)}`;
    if (isoToUtc(thisYear) >= now.getTime()) return thisYear;
    return `${year + 1}-${pad(item.recurring.month)}-${pad(item.recurring.day)}`;
  }
  return null;
}

/**
 * Applicable obligations for a profile. An unknown headcount keeps
 * threshold-based items visible as "peut_etre" — an unknown is NEVER read as
 * "not concerned". Sorted by urgency: close deadlines, upcoming, in force.
 */
export function matchRegulatoryItems(
  profile: ComplianceProfile,
  now: Date,
): RegulatoryWatchResult {
  const matches: RegulatoryMatch[] = [];
  for (const item of REGULATORY_ITEMS) {
    if (item.verticals && !item.verticals.includes(profile.vertical)) continue;

    let applies: RegulatoryMatch["applies"] = "oui";
    let conditionText = item.verticals
      ? `s'applique au vertical ${profile.vertical}`
      : "s'applique à toutes les entreprises";
    if (item.minHeadcount !== undefined) {
      const sourceText =
        profile.headcountSource === "equipe"
          ? "effectif estimé depuis l'équipe"
          : "effectif déclaré";
      if (profile.headcount === null) {
        applies = "peut_etre";
        conditionText = `seuil de ${item.minHeadcount} salariés — effectif non renseigné, applicabilité à confirmer`;
      } else if (profile.headcount >= item.minHeadcount) {
        conditionText = `${sourceText} ${profile.headcount} ≥ seuil de ${item.minHeadcount} salariés`;
      } else if (profile.headcountSource === "equipe") {
        // A staff-derived figure can be a PARTIAL entry (optional module):
        // below-threshold NEVER silently excludes on an estimate.
        applies = "peut_etre";
        conditionText =
          `effectif estimé depuis l'équipe (${profile.headcount} fiches actives) < seuil de ` +
          `${item.minHeadcount} salariés — saisie RH possiblement partielle, applicabilité à confirmer`;
      } else {
        continue; // declared figure below threshold: genuinely not applicable
      }
    }

    const deadlineIso = nextDeadline(item, now);
    let status: RegulatoryMatch["status"] = "en_vigueur";
    let daysUntil: number | null = null;
    if (deadlineIso !== null) {
      const delta = Math.ceil((isoToUtc(deadlineIso) - now.getTime()) / DAY_MS);
      if (delta >= 0) {
        daysUntil = delta;
        status = delta <= SOON_DAYS ? "echeance_proche" : "a_venir";
      }
    }
    const deadlineText =
      daysUntil !== null && deadlineIso !== null
        ? ` — échéance ${deadlineIso} (dans ${daysUntil} j)`
        : "";

    matches.push({
      ...item,
      applies,
      status,
      nextDeadline: daysUntil !== null ? deadlineIso : null,
      daysUntil,
      reason: `${conditionText}${deadlineText}`,
    });
  }

  const rank = { echeance_proche: 0, a_venir: 1, en_vigueur: 2 } as const;
  matches.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.daysUntil ?? Number.MAX_SAFE_INTEGER) - (b.daysUntil ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    version: REGULATORY_WATCH_VERSION,
    matches,
    label: "information générale à date du catalogue — ne remplace pas un conseil juridique",
  };
}
