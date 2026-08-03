/*
 * F2 — photo → imputation : SUGGÉRER l'affaire d'une pièce.
 *
 * La promesse du pivot est « l'affaire se remplit toute seule ». Elle se tient
 * si et seulement si on ne remplit rien de faux : une dépense rattachée au
 * mauvais chantier fabrique DEUX marges fausses, celle qui l'encaisse et celle
 * qui la perd, et aucune des deux ne se remarque.
 *
 * D'où trois décisions, toutes dictées par l'asymétrie du coût des erreurs :
 *
 *  1. On ne crée JAMAIS d'imputation ici. Une imputation `AUTO` non confirmée
 *     entrerait dans le calcul de marge — donc un coût que personne n'a validé
 *     déciderait d'un chiffre montré au patron. Le moteur propose, il n'écrit
 *     pas. Ce qui est accepté est écrit en `CONFIRMEE`, ce qui est choisi à la
 *     main en `MANUELLE` : la différence entre les deux EST la mesure de F2.
 *  2. On s'abstient explicitement. Ne rien proposer laisse un problème visible
 *     (l'utilisateur impute à la main, comme aujourd'hui) ; proposer au hasard
 *     rend le problème muet. « Aucune suggestion » est une réponse.
 *  3. Chaque suggestion porte ses RAISONS, en clair. Une proposition qu'on ne
 *     peut pas contester est une proposition qu'on valide par réflexe.
 *
 * Zéro LLM : le rapprochement est déterministe et testable contre des cas
 * écrits à la main. Le modèle a déjà fait sa part en lisant la photo (2.16).
 */

import { supplierKey } from "./classeurMemory.js";

/** Bump à chaque changement de règle de rapprochement. */
export const AFFAIRE_SUGGESTION_RULES_VERSION = "2026-08-03";

export interface SuggestionDocument {
  /** Nom fournisseur VALIDÉ si l'humain a corrigé, sinon celui lu par le modèle. */
  readonly supplierName: string | null;
  /** YYYY-MM-DD, ou `null` si la date n'a pas été lue. */
  readonly docDate: string | null;
}

export interface SuggestionAffaire {
  readonly id: string;
  readonly reference: string;
  readonly label: string;
  readonly status: string;
  readonly startDate: string | null;
  readonly plannedEndDate: string | null;
  readonly actualEndDate: string | null;
}

/**
 * Ce que le tenant a déjà rattaché lui-même : fournisseur -> affaire, et combien
 * de fois. Dérivé À LA LECTURE des imputations non révoquées, jamais stocké,
 * jamais partagé entre tenants (règle 7 du CLAUDE.md).
 */
export interface SupplierAffaireHistory {
  readonly supplierKey: string;
  readonly affaireId: string;
  readonly count: number;
}

/** Motif d'une suggestion — affiché tel quel, jamais un score nu. */
export type SuggestionReason =
  | { readonly kind: "historique_fournisseur"; readonly count: number }
  | { readonly kind: "dans_la_periode" }
  | { readonly kind: "seule_affaire_en_cours" };

export interface AffaireSuggestion {
  readonly affaireId: string;
  readonly reference: string;
  readonly label: string;
  readonly reasons: readonly SuggestionReason[];
}

/**
 * Résultat — union discriminée, comme la marge (4.1) : un écran ne peut pas
 * afficher une suggestion qui n'existe pas, et l'abstention porte son motif.
 */
export type SuggestionOutcome =
  | { readonly kind: "suggestions"; readonly items: readonly AffaireSuggestion[] }
  | {
      readonly kind: "abstention";
      readonly why:
        | "aucune_affaire_ouverte"
        | "aucun_signal"
        | "signaux_partages"
        | "piece_illisible"
        // Rendu par la route, pas par le moteur : la pièce porte déjà son
        // affaire. Il vit quand même dans l'union, sinon le contrat côté web
        // retombe sur `string` et n'importe quelle faute de frappe passe.
        | "deja_rattachee";
    };

/** Statuts qui peuvent encore recevoir une dépense. Une affaire terminée,
 *  perdue ou archivée n'en reçoit plus : proposer d'y rattacher une facture
 *  d'aujourd'hui serait une suggestion visiblement absurde. */
const OPEN_STATUSES = new Set(["ACCEPTEE", "EN_COURS", "DEVIS_ENVOYE"]);

/** Tolérance autour des bornes d'une affaire, en jours. Un livreur facture le
 *  lendemain, un fournisseur en fin de mois : coller aux dates exactes ferait
 *  rater le cas le plus courant. */
const WINDOW_SLACK_DAYS = 15;
const DAY_MS = 86_400_000;

function parseDay(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(time) ? null : time;
}

/** La pièce tombe-t-elle dans la fenêtre de l'affaire (bornes élargies) ? */
function withinWindow(document: SuggestionDocument, affaire: SuggestionAffaire): boolean {
  const day = parseDay(document.docDate);
  if (day === null) return false;
  const start = parseDay(affaire.startDate);
  const end = parseDay(affaire.actualEndDate) ?? parseDay(affaire.plannedEndDate);
  // Sans aucune borne, « dans la période » ne veut rien dire : on ne l'invoque pas.
  if (start === null && end === null) return false;
  if (start !== null && day < start - WINDOW_SLACK_DAYS * DAY_MS) return false;
  if (end !== null && day > end + WINDOW_SLACK_DAYS * DAY_MS) return false;
  return true;
}

/**
 * Propose une ou plusieurs affaires pour une pièce. PURE : aucune I/O, aucune
 * horloge, aucun appel modèle.
 *
 * L'ordre de force des signaux est fixe et assumé :
 *
 *   1. l'historique du tenant  — « vous avez déjà rattaché ce fournisseur ici » ;
 *   2. la période             — la pièce tombe dans les dates du chantier ;
 *   3. l'affaire unique       — il n'y en a qu'une d'ouverte.
 *
 * Le signal 3 ne suffit JAMAIS seul à trancher entre plusieurs affaires : il
 * n'existe que quand il n'y a pas d'ambiguïté à trancher.
 */
export function suggestAffaires(
  document: SuggestionDocument,
  affaires: readonly SuggestionAffaire[],
  history: readonly SupplierAffaireHistory[],
): SuggestionOutcome {
  const open = affaires.filter((affaire) => OPEN_STATUSES.has(affaire.status));
  if (open.length === 0) return { kind: "abstention", why: "aucune_affaire_ouverte" };

  const key = document.supplierName === null ? null : supplierKey(document.supplierName);
  // Ni fournisseur ni date : la photo n'a rien donné d'exploitable. Le dire vaut
  // mieux que proposer la première affaire venue.
  if (key === null && document.docDate === null) {
    return { kind: "abstention", why: "piece_illisible" };
  }

  const scored = open.map((affaire) => {
    const reasons: SuggestionReason[] = [];
    const seen =
      key === null
        ? undefined
        : history.find((entry) => entry.supplierKey === key && entry.affaireId === affaire.id);
    if (seen && seen.count > 0) {
      reasons.push({ kind: "historique_fournisseur", count: seen.count });
    }
    if (withinWindow(document, affaire)) reasons.push({ kind: "dans_la_periode" });
    return { affaire, reasons, history: seen?.count ?? 0 };
  });

  const withHistory = scored.filter((entry) => entry.history > 0);
  const withWindow = scored.filter((entry) =>
    entry.reasons.some((reason) => reason.kind === "dans_la_periode"),
  );

  // L'historique prime : c'est le seul signal que l'utilisateur a lui-même
  // produit, et il porte son propre compte de preuves.
  if (withHistory.length > 0) {
    const top = Math.max(...withHistory.map((entry) => entry.history));
    const leaders = withHistory.filter((entry) => entry.history === top);
    // Deux affaires à égalité parfaite : trancher au hasard serait pire que
    // demander. On propose les deux et l'humain choisit.
    return {
      kind: "suggestions",
      items: leaders.map((entry) => ({
        affaireId: entry.affaire.id,
        reference: entry.affaire.reference,
        label: entry.affaire.label,
        reasons: entry.reasons,
      })),
    };
  }

  if (withWindow.length === 1) {
    const only = withWindow[0] as (typeof withWindow)[number];
    return {
      kind: "suggestions",
      items: [
        {
          affaireId: only.affaire.id,
          reference: only.affaire.reference,
          label: only.affaire.label,
          reasons: only.reasons,
        },
      ],
    };
  }
  // Plusieurs chantiers ouverts en même temps couvrent la même date : c'est le
  // cas NORMAL d'un artisan, et la date ne départage rien. On ne propose pas un
  // gagnant arbitraire.
  if (withWindow.length > 1) return { kind: "abstention", why: "signaux_partages" };

  // Dernier recours : une seule affaire ouverte. Signal faible, donc dit comme
  // tel — et il ne s'applique QUE si la pièce ne la contredit pas.
  //
  // Le commentaire disait déjà « et la pièce ne la contredit pas », le code ne
  // le vérifiait pas : une facture de 2020 était proposée pour un chantier de
  // 2026. C'était aussi incohérent avec le cas à deux affaires, où l'on
  // s'abstient. Le nombre d'affaires ouvertes ne change pas ce qu'une date dit.
  if (open.length === 1) {
    const only = open[0] as SuggestionAffaire;
    const day = parseDay(document.docDate);
    const hasWindow =
      parseDay(only.startDate) !== null ||
      parseDay(only.actualEndDate) !== null ||
      parseDay(only.plannedEndDate) !== null;
    if (day !== null && hasWindow && !withinWindow(document, only)) {
      return { kind: "abstention", why: "aucun_signal" };
    }
    return {
      kind: "suggestions",
      items: [
        {
          affaireId: only.id,
          reference: only.reference,
          label: only.label,
          reasons: [{ kind: "seule_affaire_en_cours" }],
        },
      ],
    };
  }

  return { kind: "abstention", why: "aucun_signal" };
}

/** Regroupe des imputations passées en historique fournisseur -> affaire. */
export function buildSupplierHistory(
  rows: readonly { supplierName: string | null; affaireId: string }[],
): SupplierAffaireHistory[] {
  const counts = new Map<string, { supplierKey: string; affaireId: string; count: number }>();
  for (const row of rows) {
    const key = row.supplierName === null ? null : supplierKey(row.supplierName);
    if (key === null) continue;
    const id = `${key}␟${row.affaireId}`;
    const existing = counts.get(id);
    if (existing) existing.count += 1;
    else counts.set(id, { supplierKey: key, affaireId: row.affaireId, count: 1 });
  }
  return [...counts.values()];
}
