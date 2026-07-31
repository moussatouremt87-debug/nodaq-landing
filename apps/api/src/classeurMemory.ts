import type { DocExtraction } from "./classeur.js";

/*
 * Boucle d'apprentissage du classeur (ticket 2.16b) — 2.16 journalisait les
 * corrections en append-only « pour plus tard ». Voici plus tard.
 *
 * Ce que le produit apprend d'un tenant : comment SES fournisseurs
 * s'écrivent, quel type de document ils envoient, dans quelle devise. Rien
 * de plus. Pas de réentraînement de modèle, pas de vecteur, pas une ligne
 * qui sort du tenant : une mémoire DÉRIVÉE des corrections déjà en base,
 * recalculée à la lecture (même doctrine que l'échéancier 2.9 — ce qui est
 * dérivable n'est pas stocké comme vérité).
 *
 * Quatre garde-fous, tous testés :
 *
 * 1. **Une correction n'est pas une règle.** Il en faut au moins
 *    `MIN_EVIDENCE` concordantes : sinon une faute de frappe corrigée une
 *    fois deviendrait la loi pour ce fournisseur.
 * 2. **Une contradiction annule.** Si l'humain a tranché différemment sur le
 *    même champ, le champ n'est PAS appris — il est signalé.
 * 3. **La mémoire ne réécrit jamais ce que le modèle a lu.** Elle comble un
 *    trou (valeur nulle) ou signale un désaccord ; elle n'écrase rien.
 * 4. **Tout ce qui est appliqué est dit**, avec le nombre de corrections qui
 *    le fondent. « Il apprend votre entreprise » n'a de valeur que si
 *    l'utilisateur peut voir CE QU'il a appris — et le contredire.
 */

/** Corrections concordantes nécessaires avant d'ériger une règle. */
export const MIN_EVIDENCE = 2;

/** Documents relus pour construire la mémoire — borne le coût de lecture. */
export const MEMORY_WINDOW = 300;

/** Champs sur lesquels un apprentissage a du sens (le montant, jamais). */
export const LEARNABLE_FIELDS = ["supplierName", "docType", "currency"] as const;
export type LearnableField = (typeof LEARNABLE_FIELDS)[number];

/**
 * Clé de regroupement d'un fournisseur : minuscules, accents retirés, tout
 * caractère non alphanumérique SUPPRIMÉ (pas remplacé par une espace) — sans
 * quoi « S.A.R.L. » et « SARL » seraient deux fournisseurs distincts alors
 * que c'est la même entreprise écrite deux fois.
 *
 * Ce qu'elle ne fait PAS, volontairement : retirer les formes juridiques.
 * « Martin SARL » et « Martin SAS » sont deux entreprises différentes, et les
 * fusionner attribuerait à l'une les corrections de l'autre.
 */
export function supplierKey(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const normalized = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized.length >= 3 ? normalized : null;
}

/** Un document déjà corrigé par un humain — la vérité terrain de 2.16. */
export interface CorrectedDocument {
  /** Ce que le modèle avait lu au classement (figé par 2.16). */
  original: Partial<DocExtraction> | null;
  /** Ce que l'humain a validé (extraction courante). */
  final: Partial<DocExtraction> | null;
  /** Nombre de corrections humaines portées sur ce document. */
  correctionCount: number;
}

export interface LearnedField {
  field: LearnableField;
  value: string;
  /** Nombre de corrections humaines concordantes derrière la règle. */
  evidence: number;
}

export interface SupplierMemory {
  key: string;
  /** Orthographe retenue par l'humain (la plus récente et concordante). */
  displayName: string;
  fields: LearnedField[];
  /** Champs où l'humain s'est contredit : jamais appris, toujours comptés. */
  conflicts: LearnableField[];
  /** Documents corrigés qui fondent cette mémoire. */
  documents: number;
}

function stringField(
  source: Partial<DocExtraction> | null,
  field: LearnableField,
): string | null {
  const value = source?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Construit la mémoire fournisseur d'un tenant à partir de ses documents
 * corrigés. PURE : aucune I/O, aucune horloge.
 *
 * Le regroupement se fait sur le nom fournisseur VALIDÉ par l'humain (jamais
 * sur celui lu par le modèle) : c'est ce qui permet d'apprendre l'orthographe
 * correcte à partir de documents où le modèle s'était trompé.
 */
export function buildSupplierMemory(documents: readonly CorrectedDocument[]): SupplierMemory[] {
  const groups = new Map<string, { names: string[]; values: Map<LearnableField, string[]> }>();

  for (const document of documents) {
    // Seuls les documents RÉELLEMENT corrigés font foi : une extraction
    // acceptée sans relecture n'est pas une vérité terrain.
    if (document.correctionCount <= 0) continue;
    const finalName = stringField(document.final, "supplierName");
    const key = supplierKey(finalName);
    if (key === null || finalName === null) continue;

    let group = groups.get(key);
    if (!group) {
      group = { names: [], values: new Map() };
      groups.set(key, group);
    }
    group.names.push(finalName);
    for (const field of LEARNABLE_FIELDS) {
      const value = stringField(document.final, field);
      if (value === null) continue;
      const bucket = group.values.get(field) ?? [];
      bucket.push(value);
      group.values.set(field, bucket);
    }
  }

  const memories: SupplierMemory[] = [];
  for (const [key, group] of groups) {
    const fields: LearnedField[] = [];
    const conflicts: LearnableField[] = [];
    for (const field of LEARNABLE_FIELDS) {
      const values = group.values.get(field) ?? [];
      if (values.length === 0) continue;
      const counts = new Map<string, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const [topValue, topCount] = ranked[0] as [string, number];
      // Contradiction : l'humain a tranché différemment sur le même champ.
      // On n'arbitre PAS à sa place — le champ n'est pas appris.
      if (ranked.length > 1) {
        conflicts.push(field);
        continue;
      }
      if (topCount >= MIN_EVIDENCE) fields.push({ field, value: topValue, evidence: topCount });
    }
    memories.push({
      key,
      displayName: (group.names[0] as string),
      fields,
      conflicts,
      documents: group.names.length,
    });
  }
  // Tri stable : le fournisseur le mieux connu d'abord.
  return memories.sort((a, b) =>
    b.documents === a.documents ? a.key.localeCompare(b.key) : b.documents - a.documents,
  );
}

export interface AppliedLearning {
  field: LearnableField;
  /** Valeur proposée par la mémoire. */
  value: string;
  evidence: number;
  /**
   * `comble` : le modèle n'avait rien lu, la mémoire remplit.
   * `desaccord` : le modèle a lu autre chose — SIGNALÉ, jamais remplacé.
   */
  kind: "comble" | "desaccord";
  /** Ce que le modèle avait lu (pour un désaccord). */
  modelValue?: string;
}

export interface MemoryApplication {
  extraction: DocExtraction;
  applied: AppliedLearning[];
  /** Fournisseur reconnu (clé normalisée), ou null. */
  matchedSupplier: string | null;
}

/**
 * Applique la mémoire à une extraction fraîche. PURE.
 *
 * Ne remplace JAMAIS une valeur lue par le modèle : elle comble les trous, et
 * signale les désaccords pour que l'humain tranche. Une mémoire qui écraserait
 * la lecture rendrait le classeur plus sûr de lui à chaque erreur.
 */
export function applySupplierMemory(
  extraction: DocExtraction,
  memories: readonly SupplierMemory[],
): MemoryApplication {
  const key = supplierKey(extraction.supplierName);
  const memory = key === null ? undefined : memories.find((entry) => entry.key === key);
  if (!memory) return { extraction, applied: [], matchedSupplier: null };

  const next: DocExtraction = { ...extraction };
  const applied: AppliedLearning[] = [];
  for (const learned of memory.fields) {
    const current = stringField(extraction, learned.field);
    if (current === null) {
      // docType a une valeur par défaut ("autre") : la traiter comme un trou
      // serait faux, mais la laisser bloquer l'apprentissage aussi.
      if (learned.field === "docType" && extraction.docType !== "autre") continue;
      (next as Record<string, unknown>)[learned.field] = learned.value;
      applied.push({ field: learned.field, value: learned.value, evidence: learned.evidence, kind: "comble" });
      continue;
    }
    if (current === learned.value) continue;
    if (learned.field === "docType" && extraction.docType === "autre") {
      (next as Record<string, unknown>).docType = learned.value;
      applied.push({ field: "docType", value: learned.value, evidence: learned.evidence, kind: "comble" });
      continue;
    }
    applied.push({
      field: learned.field,
      value: learned.value,
      evidence: learned.evidence,
      kind: "desaccord",
      modelValue: current,
    });
  }
  return { extraction: next, applied, matchedSupplier: memory.key };
}
