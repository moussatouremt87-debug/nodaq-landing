import type { Vertical } from "./regulatoryWatch.js";

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
 */

/** Catalog snapshot date — bump on every module/defaults change. */
export const MODULE_CATALOG_VERSION = "2026-07-31";

export interface ModuleDefinition {
  id: string;
  title: string;
  /** French, shown in the settings page. */
  description: string;
  /** Web page prefix (nav filtering). */
  href: string;
  /** Agent tools removed from the toolset when the module is off. */
  tools: readonly string[];
  /** Verticals where the module is ON by default ("tous" = every vertical). */
  defaultOn: "tous" | readonly Vertical[];
}

export const MODULES: readonly ModuleDefinition[] = [
  {
    id: "classeur",
    title: "Classeur photo",
    description: "Classement photo des documents, extraction et rapprochement bancaire.",
    href: "/classeur",
    tools: [],
    defaultOn: "tous",
  },
  {
    id: "stocks",
    title: "Stocks & prix matières",
    description:
      "Suivi des stocks, alertes sous seuil, valorisation et simulation prix matières.",
    href: "/stocks",
    tools: ["check_stock_alerts", "adjust_stock", "simulate_material_prices"],
    // « autre » = fail-open (découverte) ; seuls les services purs partent
    // sans stocks par défaut — réactivable en un clic.
    defaultOn: ["industrie_btp", "retail", "negoce", "autre"],
  },
  {
    id: "immobilisations",
    title: "Immobilisations",
    description: "Registre des immobilisations, plans d'amortissement et impact trésorerie.",
    href: "/immobilisations",
    tools: [],
    defaultOn: "tous",
  },
  {
    id: "rh",
    title: "Équipe & plannings",
    description:
      "Équipe, absences, plannings capacité vs charge, performance horaire, sync Silae.",
    href: "/rh",
    tools: [
      "plan_staffing",
      "analyze_hourly_performance",
      "silae_get_employees",
      "silae_get_absences",
    ],
    defaultOn: "tous",
  },
  {
    id: "reglementaire",
    title: "Veille réglementaire",
    description: "Obligations françaises applicables au profil de l'entreprise, par urgence.",
    href: "/reglementaire",
    tools: ["check_regulatory_watch"],
    defaultOn: "tous",
  },
  {
    id: "avis",
    title: "Avis clients",
    description: "E-réputation : suivi des avis et réponses validées en 1 clic.",
    href: "/avis",
    tools: ["analyze_reputation", "draft_review_reply"],
    defaultOn: "tous",
  },
  {
    id: "rgpd",
    title: "Assistant RGPD",
    description: "Registre des traitements (art. 30), modèles CNIL et audit de complétude.",
    href: "/rgpd",
    tools: ["check_rgpd_register"],
    defaultOn: "tous",
  },
] as const;

export interface ResolvedModule {
  id: string;
  title: string;
  description: string;
  href: string;
  tools: readonly string[];
  active: boolean;
  /** Where the state comes from — explainability, 3.11 doctrine. */
  source: "defaut_vertical" | "choix";
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
    const byDefault =
      module.defaultOn === "tous" || module.defaultOn.includes(vertical);
    const override = overrides[module.id];
    const hasOverride = typeof override === "boolean";
    return {
      id: module.id,
      title: module.title,
      description: module.description,
      href: module.href,
      tools: module.tools,
      active: hasOverride ? override : byDefault,
      source: hasOverride ? "choix" : "defaut_vertical",
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
