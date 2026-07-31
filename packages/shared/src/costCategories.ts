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
 * Poste TECHNIQUE : charges de classe 6 réelles qu'aucun poste ne couvre
 * (603 variation des stocks, 600, 608…). Ce n'est PAS une catégorie attendue —
 * son absence ne manque à personne — mais sa présence prouve qu'il existe des
 * charges dont on ignore le niveau, donc que la marge ne peut pas être
 * annoncée comme complète.
 *
 * Sans ce poste, un compte non rattaché disparaissait en silence et le rapport
 * pouvait afficher un pourcentage ferme sur une base incomplète : exactement
 * ce que le ticket existe pour interdire.
 */
export const UNMAPPED_CATEGORY = "non_rattachees";

/** Ce qui peut être STOCKÉ (postes attendus + le poste technique). */
export const STORABLE_CATEGORY_IDS = [...COST_CATEGORY_IDS, UNMAPPED_CATEGORY];

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
 * Ce qu'un numéro de compte est, du point de vue de la marge.
 *
 * `exclu` et `non_rattache` sont DEUX choses différentes, et les confondre
 * était le défaut central corrigé par l'audit 2.8 : une exclusion est une
 * décision documentée (dotations, IS…), un compte non rattaché est une charge
 * réelle qu'on ne sait pas classer — la première se tait, la seconde doit
 * empêcher d'annoncer une marge complète.
 */
export type AccountClassification =
  | { kind: "poste"; category: CostCategory }
  | { kind: "exclu"; reason: string }
  | { kind: "non_rattache" }
  | { kind: "hors_charges" };

/**
 * Classe un numéro de compte. Le préfixe le plus long gagne : 611
 * (sous-traitance) doit primer sur 61 (services extérieurs), sinon un poste
 * direct serait compté en exploitation.
 */
export function classifyAccount(accountNumber: string): AccountClassification {
  if (!accountNumber.startsWith("6")) return { kind: "hors_charges" };
  const excluded = EXCLUDED_ACCOUNTS.find((entry) => accountNumber.startsWith(entry.prefix));
  if (excluded) return { kind: "exclu", reason: excluded.reason };
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
  // Classe 6, ni exclu, ni rattaché : une charge réelle de niveau inconnu.
  return best === null ? { kind: "non_rattache" } : { kind: "poste", category: best };
}

/** Poste d'un compte, `null` s'il n'entre pas dans un poste attendu. */
export function categoryForAccount(accountNumber: string): CostCategory | null {
  const classified = classifyAccount(accountNumber);
  return classified.kind === "poste" ? classified.category : null;
}
