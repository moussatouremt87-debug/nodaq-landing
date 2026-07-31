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
    expect(MODULE_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

describe("resolveModules", () => {
  it("défauts par vertical : stocks actif en BTP, inactif en services", () => {
    const btp = resolveModules("industrie_btp", {});
    expect(btp.find((m) => m.id === "stocks")).toMatchObject({
      active: true,
      source: "defaut_vertical",
    });
    const services = resolveModules("services", {});
    expect(services.find((m) => m.id === "stocks")).toMatchObject({
      active: false,
      source: "defaut_vertical",
    });
    // Les modules transverses restent actifs partout par défaut.
    expect(services.find((m) => m.id === "rgpd")?.active).toBe(true);
  });

  it("surcharge explicite : le choix de l'owner l'emporte sur le défaut, source « choix »", () => {
    const resolved = resolveModules("services", { stocks: true, avis: false });
    expect(resolved.find((m) => m.id === "stocks")).toMatchObject({
      active: true,
      source: "choix",
    });
    expect(resolved.find((m) => m.id === "avis")).toMatchObject({
      active: false,
      source: "choix",
    });
  });

  it("surcharges inconnues ou non booléennes : ignorées, jamais une exception", () => {
    const resolved = resolveModules("retail", {
      inconnu: true,
      stocks: "oui" as never,
    });
    expect(resolved.find((m) => m.id === "stocks")).toMatchObject({
      active: true,
      source: "defaut_vertical",
    });
    expect(resolved.some((m) => (m.id as string) === "inconnu")).toBe(false);
  });

  it("vertical « autre » : tout est actif par défaut (découverte, fail-open)", () => {
    const resolved = resolveModules("autre", {});
    expect(resolved.every((m) => m.active)).toBe(true);
  });
});
