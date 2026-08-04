import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * GARDE DE BRANCHEMENT du sélecteur de métier (ticket 4.2).
 *
 * `verticalChoices()` est testée à part (`@nodaq/shared`) : elle rend bien les
 * dix verticaux storables, répartis en deux groupes. Mais une fonction juste
 * ne sert à rien si un écran n'en rend qu'une moitié — et c'est EXACTEMENT la
 * régression qui a été commise puis corrigée pendant ce ticket.
 *
 * Elle mérite une garde parce que ses conséquences sont invisibles à
 * l'exécution : un sélecteur qui ne propose que la cible laisse `retail`
 * inatteignable, donc plus personne ne peut se déclarer commerçant, donc plus
 * personne ne reçoit l'obligation d'information sur les prix. Rien ne casse,
 * rien ne remonte — une obligation légale disparaît en silence.
 *
 * Garde STATIQUE, comme `freshness-wiring` : elle ne prouve pas que l'écran
 * s'affiche bien, elle prouve que les deux groupes n'ont pas disparu du code.
 */

const APP = join(import.meta.dirname, "..", "app");

/** Tout fichier d'écran qui construit un sélecteur de métier. */
function screensUsingVerticalChoices(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      const source = readFileSync(full, "utf8");
      if (source.includes("verticalChoices")) found.push({ path: full, source });
    }
  };
  walk(APP);
  return found;
}

describe("sélecteur de métier — garde de branchement", () => {
  it("au moins un écran propose le choix du métier", () => {
    // Sinon le pack n'est branché nulle part et le ticket ne livre rien : le
    // vertical resterait « autre » pour tout le monde, à vie.
    expect(screensUsingVerticalChoices().length).toBeGreaterThan(0);
  });

  it("tout écran qui propose un métier rend les DEUX groupes", () => {
    /*
     * `.cible` sans `.ancien`, c'est la régression exacte : l'ancien découpage
     * devient injoignable, et un vertical qu'on ne peut plus choisir est un
     * vertical supprimé sans le dire.
     */
    // Sur les IDENTIFIANTS, pas sur `.cible` : un écran peut déstructurer
    // (`const { cible, ancien } = verticalChoices()`) aussi bien qu'indexer.
    for (const { path, source } of screensUsingVerticalChoices()) {
      expect({ path, cible: /\bcible\b/.test(source) }).toEqual({ path, cible: true });
      expect({ path, ancien: /\bancien\b/.test(source) }).toEqual({ path, ancien: true });
    }
  });

  it("le choix du métier existe dans le SOCLE, pas seulement dans un module éteint", () => {
    /*
     * La veille réglementaire est HORS SOCLE (`defaultOn: "aucun"`). Quand
     * elle portait seule ce choix, un maçon devait rallumer un module qui ne
     * l'intéresse pas pour pouvoir dire qu'il est maçon — et tout le bénéfice
     * des packs restait inaccessible à l'installation.
     */
    const paths = screensUsingVerticalChoices().map((screen) => screen.path);
    expect(paths.some((path) => path.includes(join("reglages", "metier")))).toBe(true);
  });
});
