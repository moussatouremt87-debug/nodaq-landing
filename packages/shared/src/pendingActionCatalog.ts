/*
 * Catalogue des actions à valider (F6) — CONFIG VERSIONNÉE DATÉE, même
 * doctrine que `moduleCatalog.ts` (3.11) dont il est le pendant : 3.11 dit
 * quels modules existent, celui-ci dit à quel module se rattache chaque type
 * d'action de la file de validation.
 *
 * POURQUOI CE FICHIER EXISTE. La file listait ses onglets en dur, dans l'écran.
 * Deux conséquences, toutes deux visibles depuis le pivot (ADR-007) :
 *
 * 1. La liste avait cessé d'être vraie. Cinq types d'action sur dix n'avaient
 *    aucun onglet (`record_prospect_contact`, `submit_einvoice`,
 *    `report_einvoice_transactions`, `create_fixed_asset`, `adjust_stock`) :
 *    ces actions n'existaient que dans « Toutes », introuvables dès que la file
 *    dépassait un écran.
 * 2. Un onglet « Avis » subsistait alors que le module `avis` est hors socle
 *    depuis le pivot — un filtre vers un module dont la page a disparu.
 *
 * LA RÈGLE QUI COMMANDE TOUT LE RESTE : **une action en attente n'est JAMAIS
 * masquée.** Le registre 3.11 gouverne les ONGLETS, pas les actions. Une action
 * préparée avant l'extinction de son module reste une décision à prendre ; la
 * cacher la bloquerait pour toujours, sans un mot, pendant que le compteur de
 * la navigation continuerait de la compter. Éteindre un module retire une
 * surface produit, ça n'annule pas un engagement déjà pris.
 */

import { MODULES } from "./moduleCatalog.js";

/** Date d'instantané — à bumper à chaque changement de groupe ou de type. */
export const PENDING_ACTION_CATALOG_VERSION = "2026-08-03";

export interface PendingActionGroup {
  /** Identifiant d'onglet, stable (utilisé comme clé d'UI). */
  readonly id: string;
  /** Français, prêt à afficher. */
  readonly label: string;
  readonly types: readonly string[];
  /**
   * Module 3.11 qui porte ce groupe. `null` = SOCLE : la file de validation
   * elle-même n'est pas un module (elle fait partie du cœur), et les relances,
   * devis et écritures ne dépendent d'aucun module activable.
   */
  readonly module: string | null;
}

/**
 * Les groupes d'onglets, dans leur ordre d'affichage.
 *
 * L'ordre est FIXE : la file est lue tous les jours, et un ordre qui bouge d'un
 * chargement à l'autre donne l'impression que quelque chose a changé. Le socle
 * d'abord (ce qui touche l'argent qui rentre et sort), les modules ensuite.
 */
export const PENDING_ACTION_GROUPS: readonly PendingActionGroup[] = [
  {
    id: "relances",
    label: "Relances",
    types: ["send_dunning"],
    module: null,
  },
  {
    id: "devis",
    label: "Devis",
    types: ["create_quote"],
    module: null,
  },
  {
    id: "ecritures",
    label: "Écritures",
    types: ["submit_reconciliation", "book_invoice"],
    module: null,
  },
  {
    id: "prospection",
    label: "Prospection",
    types: ["record_prospect_contact"],
    module: null,
  },
  {
    id: "stocks",
    label: "Stocks",
    types: ["adjust_stock"],
    module: "stocks",
  },
  {
    id: "immobilisations",
    label: "Immobilisations",
    types: ["create_fixed_asset"],
    module: "immobilisations",
  },
  {
    id: "avis",
    label: "Avis clients",
    types: ["record_review_reply"],
    module: "avis",
  },
  {
    id: "facturation_electronique",
    label: "Factures électroniques",
    types: ["submit_einvoice", "report_einvoice_transactions"],
    module: "facturation_electronique",
  },
];

/** Groupe fourre-tout des types absents du catalogue — visible, jamais masqué. */
const UNCATALOGUED: PendingActionGroup = {
  id: "autres",
  label: "Autres",
  types: [],
  module: null,
};

export interface ResolvedPendingActionGroup extends PendingActionGroup {
  /** Actions EN ATTENTE de ce groupe. */
  readonly count: number;
  /**
   * Le module de ce groupe est éteint alors que des actions attendent.
   *
   * L'onglet reste — ces décisions sont toujours dues — mais l'écran le DIT,
   * sinon la présence d'actions d'un module absent de la navigation passe pour
   * un bug.
   */
  readonly moduleOff: boolean;
}

const KNOWN_MODULE_IDS = new Set(MODULES.map((module) => module.id));

/**
 * Onglets à afficher pour une file donnée. PURE.
 *
 * Un groupe sans action n'apparaît pas : un onglet à zéro est du bruit. Un
 * groupe AVEC des actions apparaît toujours, module éteint ou non — voir la
 * règle en tête de fichier.
 *
 * `inactiveModules` = modules effectivement ÉTEINTS pour ce tenant (registre
 * 3.11 résolu). Un identifiant inconnu y est ignoré plutôt que de faire
 * disparaître un onglet sur une faute de frappe.
 */
export function resolvePendingActionGroups(
  pendingTypes: readonly string[],
  inactiveModules: readonly string[],
): readonly ResolvedPendingActionGroup[] {
  const off = new Set(inactiveModules.filter((id) => KNOWN_MODULE_IDS.has(id)));
  const counts = new Map<string, number>();
  for (const type of pendingTypes) counts.set(type, (counts.get(type) ?? 0) + 1);

  const resolved: ResolvedPendingActionGroup[] = [];
  for (const group of PENDING_ACTION_GROUPS) {
    const count = group.types.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
    if (count === 0) continue;
    resolved.push({ ...group, count, moduleOff: group.module !== null && off.has(group.module) });
  }

  // Tout type hors catalogue atterrit ici : la somme des onglets doit égaler la
  // file, sinon une action s'évapore entre deux compteurs.
  const catalogued = new Set(PENDING_ACTION_GROUPS.flatMap((group) => group.types));
  const orphanCount = [...counts.entries()]
    .filter(([type]) => !catalogued.has(type))
    .reduce((sum, [, count]) => sum + count, 0);
  if (orphanCount > 0) {
    resolved.push({ ...UNCATALOGUED, count: orphanCount, moduleOff: false });
  }
  return resolved;
}
