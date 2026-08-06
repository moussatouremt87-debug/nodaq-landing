import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * GARDE DE BRANCHEMENT de l'effacement d'une fiche (art. 17).
 *
 * `DELETE /prospects/:id` a existé pendant quatre tickets sans qu'AUCUN écran
 * ne l'appelle. L'API savait effacer la fiche, anonymiser les affaires qui en
 * dérivent, tarir la recopie des contrats, purger les transcriptions — et
 * rendre la liste motivée de ce qu'elle avait dû CONSERVER. Ce compte rendu
 * est toute la justification de ne pas trancher sur les cas ambigus
 * (`ARCHIVEE` ne dit plus si un contrat a existé), et il n'avait pas de
 * destinataire : la garde restait théorique.
 *
 * Une garde STATIQUE, comme `freshness-wiring` et `vertical-select` : elle ne
 * prouve pas que l'écran s'affiche, elle prouve que le branchement et
 * l'affichage du compte rendu n'ont pas disparu du code. C'est exactement la
 * régression qui se produirait sans bruit — l'appel retiré au détour d'un
 * refactor, l'API toujours verte, et plus personne pour lire ce qui reste.
 */

const APP = join(import.meta.dirname, "..", "app");

function screens(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".tsx")) found.push({ path: full, source: readFileSync(full, "utf8") });
    }
  };
  walk(APP);
  return found;
}

/**
 * Le CORPS de la fonction qui efface, pas le fichier entier.
 *
 * La première version de cette garde cherchait ses symboles n'importe où dans
 * le fichier. C'était creux, et vérifié comme tel : retirer la puce
 * « conversations » du `window.confirm` la laissait VERTE, parce que
 * `conversationsEffacees` apparaît aussi dans le compte rendu (donc APRÈS
 * l'effacement) et que `window.confirm` est aussi utilisé par l'opposition.
 * Deux symboles présents dans le même fichier ne prouvent rien de leur
 * proximité.
 *
 * On borne donc au bloc `async function effacer(...) { … }`, en comptant les
 * accolades. Ce qu'on affirme du dialogue de confirmation ne peut plus être
 * satisfait par du texte qui vit ailleurs.
 */
function effacerBody(source: string): string | null {
  const start = source.indexOf("async function effacer(");
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

const withEffacer = (): { path: string; source: string; body: string }[] =>
  screens()
    .map((screen) => ({ ...screen, body: effacerBody(screen.source) }))
    .filter((screen): screen is { path: string; source: string; body: string } =>
      screen.body !== null,
    );

describe("effacement d'une fiche — garde de branchement", () => {
  it("un écran DÉFINIT et CÂBLE l'effacement", () => {
    /*
     * Deux moitiés, et la seconde manquait. Chercher `deleteProspect` était
     * satisfait par la seule ligne d'`import` : une fonction `effacer` morte,
     * jamais reliée à un `onClick`, passait toute la suite. Sans appelant,
     * personne ne peut exercer l'article 17 depuis le produit.
     */
    const cibles = withEffacer();
    expect(cibles.length).toBeGreaterThan(0);
    expect(cibles.some(({ body }) => body.includes("deleteProspect("))).toBe(true);
    expect(cibles.some(({ source }) => source.includes("void effacer(prospect)"))).toBe(true);
  });

  it("la CONFIRMATION annonce ce que la route détruit réellement", () => {
    /*
     * Le cœur de la garde, et la partie qui était fausse. La route efface
     * TOUTES les conversations du tenant — tous utilisateurs confondus,
     * y compris sans rapport avec la fiche. Le taire, ou le dire en laissant
     * croire que seules les conversations « de cette personne » partent, c'est
     * faire signer une destruction de données d'autrui.
     *
     * Les assertions portent sur le CORPS de `effacer`, donc sur le dialogue
     * lui-même — pas sur un symbole qui traînerait dans le compte rendu.
     */
    const dialogues = withEffacer().map(({ body }) => body);
    expect(dialogues.some((body) => body.includes("window.confirm"))).toBe(true);
    // La destruction la plus surprenante, et son RAYON.
    expect(dialogues.some((body) => /TOUTES les conversations/.test(body))).toBe(true);
    expect(dialogues.some((body) => /tous les utilisateurs/i.test(body))).toBe(true);
    // La conservation est annoncée AVANT, pas seulement rattrapée après.
    expect(dialogues.some((body) => /SAUF ceux en cours/.test(body))).toBe(true);
    // Ce que la route détruit aussi et qui se taisait.
    expect(dialogues.some((body) => /notes/.test(body))).toBe(true);
    expect(dialogues.some((body) => /relances/.test(body))).toBe(true);
  });

  it("l'écran RESTITUE ce qui a été conservé, avec son motif", () => {
    /*
     * Un écran qui appellerait la route sans afficher `affairesConservees` et
     * `contratsConserves` serait pire que pas d'écran : il donnerait le
     * sentiment d'un effacement complet là où le produit dit lui-même qu'il
     * en reste. La conservation motivée deviendrait une conservation muette.
     */
    const rendered = withEffacer().filter(
      ({ source }) =>
        source.includes("affairesConservees") &&
        source.includes("contratsConserves") &&
        source.includes("motif"),
    );
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("l'angle mort est dit AVEC sa réserve — le compte est tenant-wide", () => {
    /*
     * `contratsSansFiche` compte tous les contrats nominatifs sans fiche du
     * tenant, y compris ceux qui n'ont jamais concerné cette personne. La
     * route pose explicitement le garde-fou (« ne prétend rien sur la personne
     * effacée ») ; l'écran l'avait perdu, présentant le chiffre comme une
     * conséquence de l'effacement en cours.
     */
    const cibles = withEffacer().map(({ source }) => source);
    expect(cibles.some((source) => source.includes("contratsSansFiche"))).toBe(true);
    expect(cibles.some((source) => /ne dit rien de la personne effacée/.test(source))).toBe(true);
  });

  it("l'effacement périme les vues des AUTRES écrans", () => {
    // Un effacement touche affaires, contrats et cockpit. Sans l'événement,
    // un autre onglet continuerait d'afficher le nom qu'on vient d'effacer.
    expect(
      withEffacer().some(({ body }) => body.includes('emitDomainEvent("prospect.efface")')),
    ).toBe(true);
  });

  it("le bouton n'est pas offert à qui n'y a pas droit", () => {
    /*
     * La route est owner-only et testée comme telle côté API : ce n'est donc
     * pas une faille. Mais un membre franchissait une confirmation détaillée
     * d'action irréversible sur données personnelles pour ne récolter qu'un
     * 403 — une répétition générale d'un article 17 offerte à qui n'y a pas
     * droit. Le rôle est LU, pas supposé.
     */
    const cibles = withEffacer().map(({ source }) => source);
    expect(cibles.some((source) => source.includes("useState(false)"))).toBe(true);
    expect(cibles.some((source) => /role === "owner"/.test(source))).toBe(true);
    expect(cibles.some((source) => /isOwner &&/.test(source))).toBe(true);
  });
});
