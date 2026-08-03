import { describe, expect, it } from "vitest";
import {
  MODULE_CATALOG_VERSION,
  MODULES,
  resolveModules,
} from "../src/moduleCatalog.js";

/*
 * Modules par vertical (ticket 3.11) — catalogue en CONFIG VERSIONNÉE
 * (doctrine 2.19) + moteur PUR : état effectif = défaut du vertical,
 * surchargé par les choix explicites de l'owner. Chaque état porte sa
 * source (defaut_vertical | choix) — jamais un module qui disparaît sans
 * explication. Le cœur (cockpit, chat, validation…) n'est PAS un module.
 */

describe("catalogue de modules", () => {
  it("versionné ; chaque module a un titre, des défauts et une liste d'outils", () => {
    // Date, avec un suffixe `.N` optionnel pour deux changements le même jour :
    // réutiliser la date masquerait le second, la dater du lendemain
    // annoncerait un instantané qui n'existe pas encore.
    expect(MODULE_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    expect(MODULES.length).toBeGreaterThanOrEqual(6);
    for (const module of MODULES) {
      expect(module.id).toBeTruthy();
      expect(module.title).toBeTruthy();
      expect(module.description.length).toBeGreaterThan(10);
      expect(Array.isArray(module.tools)).toBe(true);
    }
    // Les outils rattachés sont uniques (un outil = un module au plus).
    const allTools = MODULES.flatMap((module) => module.tools);
    expect(new Set(allTools).size).toBe(allTools.length);
  });
});

describe("frontière du produit (pivot ADR-007)", () => {
  it("la liste des modules hors socle est EXPLICITE, jamais un effet de bord", () => {
    // Ce test est le compte rendu de la décision produit : éteindre ou
    // rallumer un module doit se voir ici, dans un diff, avec une intention.
    // Sans lui, un module sortirait du produit par inadvertance.
    const outOfCore = MODULES.filter((m) => m.defaultOn === "aucun").map((m) => m.id).sort();
    expect(outOfCore).toEqual(
      [
        "avis",
        "facturation_electronique",
        "immobilisations",
        "prevision_ventes",
        "reglementaire",
        "rgpd",
        "signaux_clients",
        "silae",
        "stocks",
      ].sort(),
    );
    // Le socle de l'assistant opérationnel, lui, est actif partout. `affaires`
    // l'a rejoint au ticket 4.1 : c'est le PIVOT du produit, et comme tout
    // rattachement est nullable, l'allumer n'impose aucune saisie à personne.
    const core = MODULES.filter((m) => m.defaultOn === "tous").map((m) => m.id).sort();
    expect(core).toEqual(["affaires", "brief", "classeur", "rh"]);
  });

  it("éteint n'est pas supprimé : chaque module hors socle garde son identité", () => {
    // Un module vidé de son titre ou de sa description serait une suppression
    // déguisée : l'écran Réglages ne pourrait plus proposer de le rallumer.
    for (const module of MODULES.filter((m) => m.defaultOn === "aucun")) {
      expect(module.title.length).toBeGreaterThan(3);
      expect(module.description.length).toBeGreaterThan(10);
    }
  });
});

describe("resolveModules", () => {
  it("hors socle (pivot ADR-007) : éteint partout, et la source le DIT", () => {
    // « défaut du vertical » serait faux : ces modules sont éteints pour tous
    // les verticaux. Un module qui disparaît doit porter la vraie raison —
    // c'est elle qui dit à l'utilisateur comment le rallumer.
    for (const vertical of ["industrie_btp", "services", "retail", "autre"] as const) {
      const resolved = resolveModules(vertical, {});
      expect(resolved.find((m) => m.id === "stocks")).toMatchObject({
        active: false,
        source: "hors_socle",
      });
      expect(resolved.find((m) => m.id === "rgpd")?.active).toBe(false);
      // Le socle, lui, reste actif partout — y compris sans profil.
      expect(resolved.find((m) => m.id === "classeur")?.active).toBe(true);
      expect(resolved.find((m) => m.id === "rh")?.active).toBe(true);
    }
  });

  it("éteint n'est pas supprimé : un clic de l'owner rallume, et la source suit", () => {
    // C'est la garantie qui rend le pivot réversible : le code est intact,
    // seule une surcharge sépare l'utilisateur de la fonctionnalité.
    const resolved = resolveModules("services", { stocks: true, rgpd: true });
    expect(resolved.find((m) => m.id === "stocks")).toMatchObject({
      active: true,
      source: "choix",
    });
    expect(resolved.find((m) => m.id === "rgpd")).toMatchObject({
      active: true,
      source: "choix",
    });
  });

  it("surcharge explicite : le choix de l'owner l'emporte sur le défaut, source « choix »", () => {
    const resolved = resolveModules("services", { classeur: false });
    expect(resolved.find((m) => m.id === "classeur")).toMatchObject({
      active: false,
      source: "choix",
    });
  });

  it("surcharges inconnues ou non booléennes : ignorées, jamais une exception", () => {
    const resolved = resolveModules("retail", {
      inconnu: true,
      classeur: "oui" as never,
    });
    expect(resolved.find((m) => m.id === "classeur")).toMatchObject({
      active: true,
      source: "defaut_vertical",
    });
    expect(resolved.some((m) => (m.id as string) === "inconnu")).toBe(false);
  });

  it("fail-open du SOCLE : sans profil ni surcharge, le cœur du produit répond", () => {
    // Le fail-open protège l'agent d'un profil manquant. Il ne rallume PAS
    // les modules hors socle : leur extinction est une décision produit, pas
    // un accident de configuration.
    const resolved = resolveModules("autre", {});
    const core = resolved.filter((m) => m.source === "defaut_vertical");
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((m) => m.active)).toBe(true);
  });
});
