import type { Vertical } from "./verticalPacks.js";

/*
 * Module catalog (ticket 3.11) — same doctrine as the other versioned
 * configs (2.19/3.7/3.9): which business modules exist, which agent tools
 * they carry, and their PER-VERTICAL defaults are ONE dated config. A pure
 * resolver derives the effective state: vertical default, overridden by the
 * owner's explicit choices — every state carries its source, a module never
 * (dis)appears without an explanation. The core surface (cockpit, chat,
 * validation queue, connectors, notifications) is NOT a module and can
 * never be turned off. Deactivating a module hides its pages AND removes
 * its agent tools from the toolset; the API routes stay (authorization is
 * unchanged — this is product surface, not a security boundary).
 *
 * PIVOT (ADR-007) — ce catalogue porte désormais la frontière du produit.
 *
 * nodaq devient l'assistant opérationnel quotidien des TPE à l'affaire. Les
 * modules de l'ancienne direction (co-pilote financier) sont mis HORS SOCLE :
 * `defaultOn: "aucun"`. Ils ne sont ni supprimés ni cassés — leur code, leurs
 * routes et leurs tests restent en place, et un owner les réactive en un clic.
 *
 * C'est un choix réversible, et c'est le seul mécanisme d'extinction autorisé :
 * supprimer le code rendrait la décision irréversible, casserait la CI, et
 * détruirait un actif. Un module hors socle porte la source `hors_socle` —
 * « désactivé par défaut du vertical » serait faux quand il l'est partout.
 */

/**
 * Catalog snapshot date — bump on every module/defaults change.
 *
 * A `.N` suffix disambiguates two changes landing on the SAME day (4.1 added
 * `affaires`, F5 added `brief`, both on 2026-08-03). Reusing the date would
 * hide the second change; dating it tomorrow would claim a snapshot that does
 * not exist yet. The suffix keeps the value sortable and honest.
 */
export const MODULE_CATALOG_VERSION = "2026-08-03.2";

export interface ModuleDefinition {
  id: string;
  title: string;
  /** French, shown in the settings page. */
  description: string;
  /** Web page prefix (nav filtering). Absent = no page of its own (the
   * module only carries agent tools or a cockpit card). */
  href?: string;
  /** Agent tools removed from the toolset when the module is off. */
  tools: readonly string[];
  /**
   * Verticals where the module is ON by default.
   * - `"tous"` : socle du produit, actif partout ;
   * - `"aucun"` : HORS SOCLE (pivot ADR-007) — éteint partout, réactivable ;
   * - liste : défaut par vertical.
   */
  defaultOn: "tous" | "aucun" | readonly Vertical[];
}

export const MODULES: readonly ModuleDefinition[] = [
  // ── SOCLE — l'assistant opérationnel quotidien ──────────────────────────
  {
    id: "brief",
    title: "Brief du matin",
    description:
      "Ce qui a changé et ce qui vous attend, en trois lignes — assemblé à partir des " +
      "écrans existants, sans rien recalculer.",
    href: "/brief",
    tools: [],
    // Socle : c'est le premier écran de la journée. Il n'affiche que ce que
    // les autres modules produisent, donc l'allumer n'impose rien.
    defaultOn: "tous",
  },
  {
    id: "affaires",
    title: "Affaires",
    description:
      "Chantiers, événements, interventions, missions : les pièces s'y rattachent, " +
      "et la marge se lit pendant que le travail est en cours. Le mot affiché vient " +
      "du vertical.",
    href: "/affaires",
    tools: [],
    // Pivot ADR-007 : l'affaire est le PIVOT du produit, pas une option. Elle
    // est donc au socle — et comme tout rattachement est nullable, l'allumer
    // ne change rien pour un tenant qui ne s'en sert pas : il voit une page de
    // plus, jamais une saisie de plus.
    defaultOn: "tous",
  },
  {
    id: "classeur",
    title: "Classeur photo",
    description: "Classement photo des documents, extraction et rapprochement bancaire.",
    href: "/classeur",
    tools: [],
    defaultOn: "tous",
  },
  {
    id: "rh",
    title: "Équipe & plannings",
    description: "Équipe, absences, plannings capacité vs charge, performance horaire.",
    href: "/rh",
    tools: ["plan_staffing", "analyze_hourly_performance"],
    defaultOn: "tous",
  },

  // ── HORS SOCLE (pivot ADR-007) — éteints par défaut, jamais supprimés ───
  // Aucune donnée ni ligne de code n'est perdue : un owner réactive en un clic
  // et tout répond à l'identique. Tant qu'il est éteint, le module perd la nav
  // et le toolset de l'agent — et les routes adossées à un outil répondent
  // 409 « module désactivé », par disparition de l'outil, pas par un contrôle
  // d'accès (voir docs/modules.md §3).
  {
    id: "stocks",
    title: "Stocks & prix matières",
    description:
      "Suivi des stocks, alertes sous seuil, valorisation et simulation prix matières.",
    href: "/stocks",
    tools: ["check_stock_alerts", "adjust_stock", "simulate_material_prices"],
    defaultOn: "aucun",
  },
  {
    id: "immobilisations",
    title: "Immobilisations",
    description: "Registre des immobilisations, plans d'amortissement et impact trésorerie.",
    href: "/immobilisations",
    tools: [],
    defaultOn: "aucun",
  },
  {
    id: "reglementaire",
    title: "Veille réglementaire",
    description: "Obligations françaises applicables au profil de l'entreprise, par urgence.",
    href: "/reglementaire",
    tools: ["check_regulatory_watch"],
    defaultOn: "aucun",
  },
  {
    id: "avis",
    title: "Avis clients",
    description: "E-réputation : suivi des avis et réponses validées en 1 clic.",
    href: "/avis",
    tools: ["analyze_reputation", "draft_review_reply"],
    defaultOn: "aucun",
  },
  {
    id: "rgpd",
    title: "Assistant RGPD",
    description: "Registre des traitements (art. 30), modèles CNIL et audit de complétude.",
    href: "/rgpd",
    tools: ["check_rgpd_register"],
    defaultOn: "aucun",
  },
  {
    id: "facturation_electronique",
    title: "Facturation électronique",
    description:
      "Factur-X, dépôt en plateforme agréée (PDP) et e-reporting — obligation 09/2026.",
    href: "/factures",
    tools: [],
    defaultOn: "aucun",
  },
  {
    id: "prevision_ventes",
    title: "Prévision des ventes",
    description: "Projection du chiffre d'affaires à partir des factures (carte cockpit).",
    tools: ["forecast_sales"],
    defaultOn: "aucun",
  },
  {
    id: "signaux_clients",
    title: "Signaux clients",
    description: "Segmentation churn/croissance par client sur 24 mois de facturation.",
    tools: ["analyze_customer_signals"],
    defaultOn: "aucun",
  },
  {
    id: "silae",
    title: "Silae (SIRH & paie)",
    description: "Lecture des salariés et absences depuis Silae, et synchronisation humaine.",
    tools: ["silae_get_employees", "silae_get_absences"],
    defaultOn: "aucun",
  },
] as const;

export interface ResolvedModule {
  id: string;
  title: string;
  description: string;
  href?: string;
  tools: readonly string[];
  active: boolean;
  /** Where the state comes from — explainability, 3.11 doctrine.
   * `hors_socle` : éteint par le pivot (ADR-007), réactivable en un clic —
   * le dire « défaut du vertical » serait faux quand c'est vrai partout. */
  source: "defaut_vertical" | "hors_socle" | "choix";
}

/**
 * Effective module states for a tenant: per-vertical default, overridden by
 * the owner's explicit choices. Unknown or non-boolean overrides are
 * IGNORED (never an exception, never a phantom module).
 */
export function resolveModules(
  vertical: Vertical,
  overrides: Record<string, unknown>,
): ResolvedModule[] {
  return MODULES.map((module) => {
    const outOfCore = module.defaultOn === "aucun";
    const byDefault =
      module.defaultOn === "tous" ||
      (module.defaultOn !== "aucun" && module.defaultOn.includes(vertical));
    const override = overrides[module.id];
    const hasOverride = typeof override === "boolean";
    return {
      id: module.id,
      title: module.title,
      description: module.description,
      // `exactOptionalPropertyTypes` : une clé `href: undefined` n'est PAS la
      // même chose qu'une clé absente — un module sans page n'en a pas.
      ...(module.href !== undefined ? { href: module.href } : {}),
      tools: module.tools,
      active: hasOverride ? override : byDefault,
      source: hasOverride ? "choix" : outOfCore ? "hors_socle" : "defaut_vertical",
    };
  });
}

/** Tools to strip from a toolset given the resolved modules. */
export function inactiveModuleTools(resolved: ResolvedModule[]): Set<string> {
  const tools = new Set<string>();
  for (const module of resolved) {
    if (!module.active) {
      for (const tool of module.tools) tools.add(tool);
    }
  }
  return tools;
}
