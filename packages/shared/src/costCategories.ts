/*
 * Postes de charges pour le calcul de marge (ticket 2.8).
 *
 * CONFIG VERSIONNÉE DATÉE SOURCÉE (doctrine 2.19/3.7/3.9) : le rattachement
 * d'un compte du plan comptable à un poste de charge décide de ce qui entre
 * dans une marge. Le changer change le chiffre affiché — ça se date et ça se
 * relit.
 *
 * Source : plan comptable général (PCG), règlement ANC n° 2014-03, classe 6
 * (comptes de charges). Consulté le 2026-07-31.
 */

/** Bump à chaque modification du rattachement des comptes ou des niveaux. */
export const COST_RULES_VERSION = "2026-07-31";

/**
 * Niveau de marge auquel un poste appartient.
 *  - `direct` : ce que coûte ce qui a été vendu (marge brute) ;
 *  - `exploitation` : les charges qu'il faut couvrir pour tourner.
 */
export type CostLevel = "direct" | "exploitation";

export interface CostCategory {
  id: string;
  label: string;
  level: CostLevel;
  /** Préfixes de comptes PCG. Le préfixe le PLUS LONG l'emporte (611 avant 61). */
  accounts: readonly string[];
}

export const COST_CATEGORIES: readonly CostCategory[] = [
  {
    id: "achats",
    label: "Achats consommés (matières, marchandises)",
    level: "direct",
    // 609 = rabais/remises obtenus : ils RÉDUISENT les achats, d'où le même
    // poste (leur sens est porté par le crédit, pas par une catégorie à part).
    accounts: ["601", "602", "607", "609"],
  },
  {
    id: "sous_traitance",
    label: "Sous-traitance et travaux confiés",
    level: "direct",
    accounts: ["604", "605", "611"],
  },
  {
    id: "main_oeuvre",
    label: "Charges de personnel",
    level: "exploitation",
    accounts: ["64"],
  },
  {
    id: "services_exterieurs",
    label: "Services extérieurs (loyers, énergie, assurances…)",
    level: "exploitation",
    accounts: ["606", "61", "62"],
  },
  {
    id: "impots_taxes",
    label: "Impôts et taxes (hors impôt sur les bénéfices)",
    level: "exploitation",
    accounts: ["63"],
  },
  {
    id: "autres_charges",
    label: "Autres charges de gestion courante",
    level: "exploitation",
    accounts: ["65"],
  },
] as const;

export const COST_CATEGORY_IDS = COST_CATEGORIES.map((category) => category.id);

/**
 * Comptes de classe 6 DÉLIBÉRÉMENT hors marge, et pourquoi. Les taire ferait
 * croire à un oubli ; les inclure fausserait la marge d'exploitation.
 */
export const EXCLUDED_ACCOUNTS: readonly { prefix: string; reason: string }[] = [
  { prefix: "66", reason: "charges financières : elles ne relèvent pas de l'exploitation" },
  { prefix: "67", reason: "charges exceptionnelles : par nature non récurrentes" },
  {
    prefix: "68",
    // Même garde qu'en 2.19 : amortissement ≠ décaissement.
    reason: "dotations aux amortissements : une charge calculée, pas un décaissement",
  },
  { prefix: "69", reason: "impôt sur les bénéfices : il se calcule APRÈS la marge" },
];

/**
 * Poste correspondant à un numéro de compte, `null` si le compte n'entre pas
 * dans une marge (classe ≠ 6, ou exclusion assumée ci-dessus).
 *
 * Le préfixe le plus long gagne : 611 (sous-traitance) doit primer sur 61
 * (services extérieurs), sinon un poste direct serait compté en exploitation.
 */
export function categoryForAccount(accountNumber: string): CostCategory | null {
  if (!accountNumber.startsWith("6")) return null;
  if (EXCLUDED_ACCOUNTS.some((excluded) => accountNumber.startsWith(excluded.prefix))) return null;
  let best: CostCategory | null = null;
  let bestLength = 0;
  for (const category of COST_CATEGORIES) {
    for (const prefix of category.accounts) {
      if (accountNumber.startsWith(prefix) && prefix.length > bestLength) {
        best = category;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
