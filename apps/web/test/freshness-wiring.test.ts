import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_VIEWS, MUTATION_EFFECTS, type DomainEvent } from "../lib/freshness";

/*
 * GARDE DE BRANCHEMENT (ticket 2.21 A).
 *
 * Le bus d'invalidation est testé à part (freshness.test.ts) : il réveille les
 * bonnes vues. Mais un bus parfait ne sert à rien si un écran oublie de lui
 * dire qu'il vient d'écrire — et c'est très exactement le bug d'origine, qui
 * n'était pas une erreur de calcul mais une absence d'appel.
 *
 * Ces gardes sont STATIQUES : elles ne prouvent pas que l'événement part au
 * bon moment, elles prouvent qu'il n'a pas disparu et qu'aucune écriture n'a
 * été ajoutée au produit sans qu'on dise ce qu'elle périme. C'est une garde,
 * pas une convention — une convention, personne ne la relit dans six mois.
 *
 * La liste des mutations est DÉRIVÉE de `lib/api.ts`, jamais recopiée : une
 * liste écrite à la main aurait le même défaut que le code qu'elle surveille.
 */

const WEB = join(import.meta.dirname, "..");
const APP = join(WEB, "app");

/**
 * Helpers de `lib/api.ts` qui écrivent côté serveur.
 *
 * Découpage sur les `export const X =` de premier niveau, puis détection d'un
 * verbe HTTP mutant dans le corps. Une écriture faite à la main avec `fetch`
 * échapperait à ce filtre : c'est la limite, et elle est DITE.
 */
function mutatingHelpers(): string[] {
  const source = readFileSync(join(WEB, "lib", "api.ts"), "utf-8");
  const parts = source.split(/\nexport const (\w+)(?=[ :=])/);
  const found: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const body = parts[i + 1];
    if (name && body && /method:\s*"(POST|PATCH|PUT|DELETE)"/.test(body)) found.push(name);
  }
  return found;
}

function pageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pageFiles(path));
    else if (entry.name === "page.tsx") found.push(path);
  }
  return found;
}

describe("registre des mutations", () => {
  it("toute écriture de lib/api.ts est classée", () => {
    const unclassified = mutatingHelpers().filter((name) => !(name in MUTATION_EFFECTS));
    expect(
      unclassified,
      `écritures ajoutées sans dire ce qu'elles périment :\n${unclassified.join("\n")}`,
    ).toEqual([]);
  });

  it("le registre ne classe pas d'écriture fantôme", () => {
    // Symétrie : un helper supprimé doit sortir du registre, sinon la config
    // versionnée décrit peu à peu un produit qui n'existe plus.
    const helpers = new Set(mutatingHelpers());
    const stale = Object.keys(MUTATION_EFFECTS).filter((name) => !helpers.has(name));
    expect(stale, `entrées sans helper correspondant :\n${stale.join("\n")}`).toEqual([]);
  });

  it("tout événement déclaré est réellement émis quelque part", () => {
    // Un événement que personne n'émet est une ligne de config qui rassure
    // sans rien garantir — pire qu'une ligne absente.
    const emitted = new Set<DomainEvent>();
    for (const effect of Object.values(MUTATION_EFFECTS)) {
      if (Array.isArray(effect)) for (const event of effect) emitted.add(event);
    }
    // Le chat/cockpit émettent ceux des outils d'écriture, et les connecteurs
    // émettent la purge FEC — sources hors registre HTTP.
    const fromCode = readFileSync(join(WEB, "lib", "freshness.ts"), "utf-8");
    for (const event of Object.keys(EVENT_VIEWS) as DomainEvent[]) {
      if (fromCode.includes(`: "${event}"`)) emitted.add(event);
    }
    for (const file of pageFiles(APP)) {
      const source = readFileSync(file, "utf-8");
      for (const event of Object.keys(EVENT_VIEWS) as DomainEvent[]) {
        if (source.includes(`emitDomainEvent("${event}")`)) emitted.add(event);
      }
    }
    const orphans = (Object.keys(EVENT_VIEWS) as DomainEvent[]).filter((e) => !emitted.has(e));
    expect(orphans, `événements déclarés mais jamais émis :\n${orphans.join("\n")}`).toEqual([]);
  });
});

describe("branchement de l'invalidation", () => {
  it("CHAQUE appel qui mute une vue partagée émet, pas seulement le fichier", () => {
    // Première version de cette garde : « le fichier contient au moins un
    // emitDomainEvent ». Elle laissait passer trois écritures muettes dans des
    // fichiers par ailleurs corrects (webhooks, brouillon d'action) — une garde
    // qui se contente d'un alibi par fichier ne garde rien.
    const shared = Object.entries(MUTATION_EFFECTS)
      .filter(([, effect]) => effect !== null)
      .map(([name]) => name);
    const offenders: string[] = [];
    for (const file of pageFiles(APP)) {
      const source = readFileSync(file, "utf-8");
      for (const call of shared) {
        for (const match of source.matchAll(new RegExp(`\\b${call}\\s*\\(`, "g"))) {
          // Fenêtre = du site d'appel jusqu'à la fin de son gestionnaire
          // (prochaine déclaration de fonction au même niveau), à défaut 2000
          // caractères. Statique et approximatif : ne prouve pas le MOMENT de
          // l'émission, prouve qu'il y en a une sur ce chemin-là.
          const from = match.index;
          const rest = source.slice(from + 1);
          const nextFn = rest.search(/\n {0,2}(async )?function |\n {2}const \w+ = useCallback/);
          const window = rest.slice(0, nextFn === -1 ? 2000 : nextFn);
          if (!window.includes("emitDomainEvent(")) {
            const line = source.slice(0, from).split("\n").length;
            offenders.push(`${file.slice(APP.length + 1)}:${line} — ${call}`);
          }
        }
      }
    }
    expect(offenders, `écritures qui ne périment rien :\n${offenders.join("\n")}`).toEqual([]);
  });

  it("toute vue déclarée a au moins un abonné", () => {
    // Une vue sans abonné, c'est une ligne d'`EVENT_VIEWS` qui rassure sans
    // réveiller personne : l'événement part, et aucun écran n'écoute. Douze des
    // quinze vues étaient dans ce cas au premier jet.
    const sources = pageFiles(APP)
      .concat([join(APP, "shell.tsx")])
      .map((file) => readFileSync(file, "utf-8"))
      .join("\n");
    // On ne cherche PAS le nom de la vue dans le fichier — « marge » ou
    // « stocks » s'y trouve en clair dans les libellés. Seuls comptent les
    // abonnements réels.
    const subscribed = new Set<string>();
    for (const match of sources.matchAll(/(?:useViewRefresh|useFreshness)\(\[([^\]]*)\]/g)) {
      for (const view of (match[1] ?? "").matchAll(/"(\w+)"/g)) subscribed.add(view[1] as string);
    }
    for (const match of sources.matchAll(/subscribeView\("(\w+)"/g)) {
      subscribed.add(match[1] as string);
    }
    expect(subscribed.size).toBeGreaterThan(0);
    const orphans = (Object.keys(EVENT_VIEWS) as DomainEvent[])
      .flatMap((event) => EVENT_VIEWS[event])
      .filter((view, index, all) => all.indexOf(view) === index && !subscribed.has(view));
    expect(orphans, `vues déclarées que personne n'écoute :\n${orphans.join("\n")}`).toEqual([]);
  });

  it("le chat périme les vues quand l'AGENT écrit, pas seulement l'utilisateur", () => {
    // Le cas qui a donné son nom au bug : l'employé Compta agit pendant qu'on
    // le regarde, et le cockpit reste figé sur les chiffres d'avant.
    const chat = readFileSync(join(APP, "chat", "page.tsx"), "utf-8");
    expect(chat).toContain("eventForTool(");
    expect(chat).toContain("emitDomainEvent(");
  });

  it("le cockpit et la file déclarent leur fraîcheur", () => {
    for (const page of [join(APP, "page.tsx"), join(APP, "validation", "page.tsx")]) {
      expect(readFileSync(page, "utf-8")).toContain("useFreshness(");
    }
  });

  it("la nav suit la file et les modules sans attendre une navigation", () => {
    // Le badge « N » du menu est le compteur le plus visible du produit : s'il
    // n'est abonné à rien, valider depuis le cockpit le laisse faux.
    const shell = readFileSync(join(APP, "shell.tsx"), "utf-8");
    expect(shell).toContain('subscribeView("validation"');
    expect(shell).toContain('subscribeView("nav"');
  });
});
