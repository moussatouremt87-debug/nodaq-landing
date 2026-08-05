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

function screensCalling(symbol: string): { path: string; source: string }[] {
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
      if (source.includes(symbol)) found.push({ path: full, source });
    }
  };
  walk(APP);
  return found;
}

describe("effacement d'une fiche — garde de branchement", () => {
  it("un écran appelle bien `deleteProspect`", () => {
    // Sans appelant, tout le travail de la route est inatteignable : personne
    // ne peut exercer l'article 17 depuis le produit.
    expect(screensCalling("deleteProspect").length).toBeGreaterThan(0);
  });

  it("l'écran RESTITUE ce qui a été conservé, avec son motif", () => {
    /*
     * Le cœur de la garde. Un écran qui appellerait la route sans afficher
     * `affairesConservees` et `contratsConserves` serait pire que pas d'écran :
     * il donnerait le sentiment d'un effacement complet là où le produit dit
     * lui-même qu'il en reste. La conservation motivée deviendrait une
     * conservation muette.
     */
    const screens = screensCalling("deleteProspect");
    const rendered = screens.filter(
      ({ source }) =>
        source.includes("affairesConservees") &&
        source.includes("contratsConserves") &&
        source.includes("motif"),
    );
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("l'écran dit ce qui reste HORS DE PORTÉE de l'effacement", () => {
    // `contratsSansFiche` est l'angle mort assumé : des contrats nominatifs
    // qu'aucun effacement ne peut atteindre. Le compter sans l'afficher
    // reviendrait à le taire.
    const screens = screensCalling("deleteProspect");
    expect(screens.some(({ source }) => source.includes("contratsSansFiche"))).toBe(true);
  });

  it("l'écran ANNONCE l'effacement des conversations avant de le faire", () => {
    /*
     * C'est la conséquence la plus surprenante : le chat repart à zéro pour
     * l'équipe entière. La taire ferait passer un effacement volontaire pour
     * une panne au prochain message.
     */
    const screens = screensCalling("deleteProspect");
    expect(
      screens.some(
        ({ source }) =>
          source.includes("conversationsEffacees") && source.includes("window.confirm"),
      ),
    ).toBe(true);
  });

  it("l'effacement périme les vues des AUTRES écrans", () => {
    // Un effacement touche affaires, contrats et cockpit. Sans l'événement,
    // un autre onglet continuerait d'afficher le nom qu'on vient d'effacer.
    const screens = screensCalling("deleteProspect");
    expect(screens.some(({ source }) => source.includes('emitDomainEvent("prospect.efface")'))).toBe(
      true,
    );
  });
});
