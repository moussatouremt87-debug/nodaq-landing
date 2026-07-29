import type { FecEntry } from "./parse.js";

/*
 * Fixed-asset derivation from FEC entries (ticket 2.19): 2x accounts carry
 * the assets (gross value), 28x the accumulated depreciation. This produces
 * PROPOSALS for a human validation screen — never silent inserts. 2x/28x
 * inconsistencies are SIGNALED, not silently fixed.
 */

export interface FixedAssetProposal {
  /** Account number (e.g. "2183") — used as source reference. */
  accountNum: string;
  label: string;
  /** Category guess from the PCG account root (validated by the human). */
  category: "informatique" | "logiciel" | "vehicule" | "materiel" | "mobilier" | "agencement";
  /** Earliest movement date on the account (best-effort in-service date). */
  inServiceDate: string;
  /** Gross value = debits − credits on the 2x account. */
  baseCents: number;
  /** Accumulated depreciation = credits − debits on the matching 28x. */
  priorDepreciationCents: number;
  warnings: string[];
}

/** PCG account root -> V1 category (human-validated downstream). */
function categoryFor(accountNum: string): FixedAssetProposal["category"] {
  if (accountNum.startsWith("205")) return "logiciel";
  if (accountNum.startsWith("2183")) return "informatique";
  if (accountNum.startsWith("2182")) return "vehicule";
  if (accountNum.startsWith("2184")) return "mobilier";
  if (accountNum.startsWith("2181") || accountNum.startsWith("2135")) return "agencement";
  return "materiel";
}

/** Immobilisations amortissables : comptes 20/21 hors 28x (amortissements). */
function isAssetAccount(accountNum: string): boolean {
  return /^2[01]/.test(accountNum) && !accountNum.startsWith("28");
}

export function deriveFixedAssets(entries: FecEntry[]): FixedAssetProposal[] {
  const assets = new Map<
    string,
    { label: string; first: string; debit: number; credit: number }
  >();
  const depreciation = new Map<string, { debit: number; credit: number }>();

  for (const entry of entries) {
    if (isAssetAccount(entry.compteNum)) {
      const bucket = assets.get(entry.compteNum) ?? {
        label: entry.compteLib || entry.compteNum,
        first: entry.ecritureDate,
        debit: 0,
        credit: 0,
      };
      if (entry.ecritureDate < bucket.first) bucket.first = entry.ecritureDate;
      bucket.debit += entry.debitCents;
      bucket.credit += entry.creditCents;
      assets.set(entry.compteNum, bucket);
    } else if (entry.compteNum.startsWith("28")) {
      const key = entry.compteNum.slice(2); // 28154 -> matches 2154
      const bucket = depreciation.get(key) ?? { debit: 0, credit: 0 };
      bucket.debit += entry.debitCents;
      bucket.credit += entry.creditCents;
      depreciation.set(key, bucket);
    }
  }

  const proposals: FixedAssetProposal[] = [];
  const matchedDepreciation = new Set<string>();
  for (const [accountNum, bucket] of [...assets.entries()].sort()) {
    const baseCents = bucket.debit - bucket.credit;
    if (baseCents <= 0) continue; // compte soldé (cession passée) : rien à reprendre
    // 28x match: longest suffix key that the asset account starts with
    // ("2154300" matches 28x key "154300" or "154"...).
    let prior = 0;
    const warnings: string[] = [];
    for (const [key, dep] of depreciation.entries()) {
      if (accountNum.slice(1).startsWith(key.slice(0, accountNum.length - 1)) === false) continue;
      if (accountNum === `2${key}` || accountNum.startsWith(`2${key}`)) {
        prior += dep.credit - dep.debit;
        matchedDepreciation.add(key);
      }
    }
    if (prior < 0) {
      warnings.push("amortissements 28x débiteurs (incohérence)");
      prior = 0;
    }
    if (prior > baseCents) {
      warnings.push("amortissements 28x supérieurs à la valeur brute 2x (incohérence)");
      prior = baseCents;
    }
    if (prior === 0) warnings.push("aucun amortissement 28x rattaché");
    proposals.push({
      accountNum,
      label: bucket.label,
      category: categoryFor(accountNum),
      inServiceDate: bucket.first,
      baseCents,
      priorDepreciationCents: prior,
      warnings,
    });
  }
  return proposals;
}
