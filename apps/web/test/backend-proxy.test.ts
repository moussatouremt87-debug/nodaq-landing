import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * GARDE DU PROXY `/backend/*`.
 *
 * Ce que cette garde existe pour empêcher, et qui est arrivé : `events` avait
 * été ajouté au code sans l'être à `BUSINESS_PREFIXES`. La requête tombait sur
 * le 404 HTML de Next, et `EventSource` n'a pas le droit de reprendre sur un
 * statut != 200 — donc le flux mourait DÉFINITIVEMENT, sans un mot, et le
 * produit se comportait exactement comme avant le ticket qui venait de le
 * livrer. La revue a aussi trouvé `affaires` et `contrats` manquants depuis
 * plus longtemps.
 *
 * Une liste de préfixes tenue à la main ne peut pas être gardée par la
 * relecture : elle se compare au code.
 */

const WEB = join(import.meta.dirname, "..");

function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "test") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) found.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(WEB, "app"));
  walk(join(WEB, "lib"));
  return found;
}

/** Premiers segments appelés derrière `/backend/`, tels qu'écrits dans le code. */
function usedPrefixes(): Set<string> {
  const used = new Set<string>();
  for (const source of sources()) {
    for (const match of source.matchAll(/["'`]\/backend\/([a-z0-9-]+)/g)) {
      const prefix = match[1];
      if (prefix) used.add(prefix);
    }
  }
  return used;
}

function declaredPrefixes(): Set<string> {
  const config = readFileSync(join(WEB, "next.config.ts"), "utf8");
  const block = config.slice(
    config.indexOf("const BUSINESS_PREFIXES"),
    config.indexOf("];", config.indexOf("const BUSINESS_PREFIXES")),
  );
  return new Set([...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1] as string));
}

describe("tout chemin /backend appelé par le code est proxifié", () => {
  it("aucun préfixe utilisé n'est absent de la configuration", () => {
    const declared = declaredPrefixes();
    const manquants = [...usedPrefixes()].filter((prefix) => !declared.has(prefix));
    // Le message porte la liste : « un test rouge » sans dire QUOI ferait
    // chercher dans vingt fichiers.
    expect(manquants, `préfixes appelés mais non proxifiés : ${manquants.join(", ")}`).toEqual([]);
  });

  it("le flux d'invalidation en fait partie — c'est celui qui est mort en silence", () => {
    expect(declaredPrefixes().has("events")).toBe(true);
  });
});
