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
  it("tout écran qui MUTE une vue partagée émet un événement de domaine", () => {
    const offenders: string[] = [];
    for (const file of pageFiles(APP)) {
      const source = readFileSync(file, "utf-8");
      const mutates = Object.entries(MUTATION_EFFECTS)
        .filter(([, effect]) => effect !== null)
        .map(([name]) => name)
        .filter((call) => new RegExp(`\\b${call}\\s*\\(`).test(source));
      if (mutates.length > 0 && !source.includes("emitDomainEvent(")) {
        offenders.push(`${file.slice(APP.length + 1)} (mutations : ${mutates.join(", ")})`);
      }
    }
    expect(offenders, `écrans qui écrivent sans périmer les vues :\n${offenders.join("\n")}`).toEqual(
      [],
    );
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
