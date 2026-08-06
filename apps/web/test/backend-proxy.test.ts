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

/**
 * Premiers segments réellement appelés — deux formes, pas une.
 *
 * La première version ne captait que les littéraux `"/backend/xxx"`. Or 95 %
 * des appels passent par `call(schema, "/chemin")`, qui préfixe lui-même
 * (`lib/api.ts`). Mesuré : 7 préfixes détectés contre 25 déclarés — et
 * `affaires` et `contrats`, les deux manques que la revue avait trouvés, sont
 * appelés par `call()` donc étaient INVISIBLES à la garde. Elle n'aurait pas
 * trouvé ce qu'elle prétendait garder, et ne trouvera pas le prochain.
 */
function usedPrefixes(): Set<string> {
  const used = new Set<string>();
  for (const source of sources()) {
    // `fetch("/backend/xxx")` — appels directs.
    for (const match of source.matchAll(/["'`]\/backend\/([a-z0-9-]+)/g)) {
      const prefix = match[1];
      if (prefix) used.add(prefix);
    }
    /*
     * `call(Schema, "/xxx/...")` — la forme majoritaire.
     *
     * Le motif ne peut PAS s'arrêter à la première virgule : dès que le
     * premier argument en contient une (`z.union([A, B])`), l'appel devient
     * invisible. Mesuré : 26 préfixes vus sur 27, le manquant étant
     * `rapports`, appelé avec un `z.union` en premier argument. C'est la
     * classe de cécité exacte qui avait caché `brief` pendant des mois.
     *
     * On prend donc une FENÊTRE après `call(` et on y cherche le premier
     * chemin littéral, quel que soit ce qui précède.
     */
    for (const match of source.matchAll(/\bcall\s*\(/g)) {
      const fenetre = source.slice(match.index, match.index + 300);
      const chemin = /["'`]\/([a-z0-9-]+)/.exec(fenetre);
      if (chemin?.[1]) used.add(chemin[1]);
    }
  }
  return used;
}

/**
 * Les webhooks ont leur propre bloc de réécriture, volontairement restreint à
 * deux sous-chemins d'administration : la route de RÉCEPTION est publique et
 * ne passe pas par le proxy. Les compter comme un préfixe manquant ferait
 * crier la garde sur une décision délibérée — et une garde qui crie pour rien
 * finit ignorée.
 */
const HANDLED_ELSEWHERE = new Set(["webhooks"]);

/**
 * Sous-chemins réellement proxifiés du bloc webhooks.
 *
 * Exempter le PRÉFIXE entier réintroduisait le défaut de `brief` : un futur
 * `call(X, "/webhooks/deliveries")` tomberait sur le 404 de Next et la garde
 * resterait verte. On vérifie donc que les sous-chemins appelés sont bien
 * parmi ceux que la configuration déclare.
 */
const WEBHOOK_ALLOWED = ["webhooks/endpoints", "webhooks/events"];

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
    const manquants = [...usedPrefixes()].filter(
      (prefix) => !declared.has(prefix) && !HANDLED_ELSEWHERE.has(prefix),
    );
    // Le message porte la liste : « un test rouge » sans dire QUOI ferait
    // chercher dans vingt fichiers.
    expect(manquants, `préfixes appelés mais non proxifiés : ${manquants.join(", ")}`).toEqual([]);
  });

  it("aucun sous-chemin webhook n'est appelé hors des deux déclarés", () => {
    // L'exemption porte sur un préfixe ; la configuration ne déclare que deux
    // sous-chemins. Sans cette vérification, l'exemption serait un trou.
    const appeles = new Set<string>();
    for (const source of sources()) {
      for (const match of source.matchAll(/["'`]\/(webhooks\/[a-z0-9-]+)/g)) {
        const chemin = match[1];
        if (chemin) appeles.add(chemin);
      }
    }
    const hors = [...appeles].filter((chemin) => !WEBHOOK_ALLOWED.includes(chemin));
    expect(hors, `sous-chemins webhook non proxifiés : ${hors.join(", ")}`).toEqual([]);
  });

  it("la garde VOIT les appels faits via `call()`, pas seulement les fetch directs", () => {
    /*
     * Sans cette assertion, la garde pouvait redevenir aveugle sans que rien
     * ne rougisse : c'est précisément l'état dans lequel elle a été livrée.
     * `affaires` et `contrats` ne sont atteints que par `call()`.
     */
    const used = usedPrefixes();
    expect(used.has("affaires")).toBe(true);
    expect(used.has("contrats")).toBe(true);
    // …le flux, atteint par un `fetch` direct…
    expect(used.has("events")).toBe(true);
    // …et un appel dont le PREMIER argument contient une virgule, la forme
    // qui échappait à la version précédente.
    expect(used.has("rapports")).toBe(true);
  });
});
