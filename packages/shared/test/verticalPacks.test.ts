import { describe, expect, it } from "vitest";
import {
  affaireWords,
  PIVOT_VERTICALS,
  VERTICAL_PACKS,
  VERTICAL_PACKS_VERSION,
  VERTICALS,
  verticalChoices,
  verticalLabel,
} from "../src/index.js";

/*
 * Packs verticaux (4.2) — « un vertical = un fichier de données, jamais une
 * ligne de code métier » (ADR-007).
 *
 * Ce que ces tests défendent, dans l'ordre : qu'aucun vertical ne se retrouve
 * sans mot ni libellé (le produit dirait « affaire » à un paysagiste sans que
 * rien ne le signale), et qu'aucun vertical existant ne DISPARAISSE — une
 * valeur retirée de la liste, c'est un tenant en base dont la fiche ne se
 * relit plus.
 */

describe("config versionnée datée", () => {
  it("porte une version datée", () => {
    expect(VERTICAL_PACKS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });

  it("chaque vertical de la liste a UN pack, et réciproquement", () => {
    // `Record<Vertical, …>` rend l'oubli impossible à la compilation ; ce test
    // attrape l'inverse — un pack orphelin dont l'id ne serait pas storable.
    expect(Object.keys(VERTICAL_PACKS).sort()).toEqual([...VERTICALS].sort());
  });
});

describe("aucun vertical ne disparaît", () => {
  it("les cinq verticaux d'avant le pivot sont TOUJOURS storables", () => {
    /*
     * Ils ne sont plus la cible commerciale, ils restent en base. Retirer
     * `retail` de la liste, c'est un `CHECK` qui refuse la fiche d'un tenant
     * qui existe — et, plus grave, c'est lui retirer l'obligation
     * « information du consommateur sur les prix » que la veille lui affiche
     * aujourd'hui. On n'efface pas une obligation légale par refonte du
     * découpage commercial.
     */
    for (const legacy of ["industrie_btp", "retail", "negoce", "services", "autre"]) {
      expect(VERTICALS).toContain(legacy);
    }
  });

  it("les cinq verticaux de la cible du pivot existent", () => {
    expect([...PIVOT_VERTICALS].sort()).toEqual(
      ["batiment", "evenementiel", "maintenance", "paysage", "services_projet"].sort(),
    );
    for (const cible of PIVOT_VERTICALS) expect(VERTICALS).toContain(cible);
  });

  it("`inTarget` distingue la cible du legacy, sans rien supprimer", () => {
    const cibles = Object.values(VERTICAL_PACKS)
      .filter((pack) => pack.inTarget)
      .map((pack) => pack.id);
    expect(cibles.sort()).toEqual([...PIVOT_VERTICALS].sort());
  });
});

describe("le mot vient du pack, jamais du code", () => {
  it("chaque pack porte un vocabulaire complet et accordé", () => {
    for (const pack of Object.values(VERTICAL_PACKS)) {
      const { singular, plural, indefinite, definite, newLabel, noneLabel } = pack.words;
      for (const mot of [singular, plural, indefinite, definite, newLabel, noneLabel]) {
        expect(mot.length).toBeGreaterThan(0);
      }
      // L'accord vit DANS le pack : un écran qui testerait
      // `singular === "affaire"` pour choisir un « e » réintroduirait une
      // règle de langue dans une feature.
      expect(indefinite.endsWith(singular)).toBe(true);
      expect(noneLabel.endsWith(singular)).toBe(true);
      expect(newLabel.endsWith(singular)).toBe(true);
    }
  });

  it("les métiers de la cible ont chacun LEUR mot, pas un mot générique", () => {
    // C'est tout l'objet du ticket : dire « chantier » au maçon, « événement »
    // au traiteur, « intervention » au dépanneur. Un pack qui rendrait
    // « affaire » serait un pack qui n'a pas été écrit.
    expect(affaireWords("batiment").singular).toBe("chantier");
    expect(affaireWords("paysage").singular).toBe("chantier");
    expect(affaireWords("evenementiel").singular).toBe("événement");
    expect(affaireWords("maintenance").singular).toBe("intervention");
    expect(affaireWords("services_projet").singular).toBe("mission");
    for (const cible of PIVOT_VERTICALS) {
      expect(affaireWords(cible).singular).not.toBe("affaire");
    }
  });

  it("le genre suit le mot — « un événement », « une intervention »", () => {
    // Le piège que le champ `indefinite` existe pour éviter : « une événement »
    // devant un client coûte la crédibilité de tout l'écran.
    expect(affaireWords("evenementiel").indefinite).toBe("un événement");
    expect(affaireWords("evenementiel").newLabel).toBe("Nouvel événement");
    expect(affaireWords("maintenance").indefinite).toBe("une intervention");
    expect(affaireWords("maintenance").newLabel).toBe("Nouvelle intervention");
    expect(affaireWords("maintenance").noneLabel).toBe("Aucune intervention");
  });

  it("inconnu, vide ou nul → « affaire », jamais un mot deviné", () => {
    // Ne devine JAMAIS à partir du nom de l'entreprise ou de ses pièces : se
    // tromper de mot devant un client est gratuit et ridicule.
    for (const inconnu of [null, undefined, "", "boulangerie", "BATIMENT"]) {
      expect(affaireWords(inconnu).singular).toBe("affaire");
    }
  });
});

describe("les libellés aussi viennent du pack", () => {
  it("chaque vertical a un libellé affichable et distinct", () => {
    const labels = Object.values(VERTICAL_PACKS).map((pack) => pack.label);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    // Deux verticaux au même libellé donneraient un sélecteur d'onboarding où
    // le patron ne peut pas choisir.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("`verticalLabel` répond pour l'inconnu au lieu de rendre vide", () => {
    expect(verticalLabel("batiment")).toBe(VERTICAL_PACKS.batiment.label);
    expect(verticalLabel("boulangerie")).toBe(VERTICAL_PACKS.autre.label);
    expect(verticalLabel(null)).toBe(VERTICAL_PACKS.autre.label);
  });
});

describe("ce qu'un dirigeant peut CHOISIR", () => {
  it("tout vertical storable reste joignable — sinon on l'a supprimé sans le dire", () => {
    /*
     * LA propriété de ce sélecteur, et elle a déjà été cassée une fois.
     *
     * Masquer l'ancien découpage rendait `retail` inatteignable pour qui n'y
     * était pas déjà : plus personne ne pouvait se déclarer commerçant, donc
     * plus personne ne recevait l'obligation d'information sur les prix. Le
     * `CHECK` gardait la valeur, l'écran la rendait inaccessible — même
     * résultat que de la supprimer, c'est-à-dire ce que la migration déclare
     * inacceptable. Un vertical qu'on ne peut plus choisir est un vertical
     * supprimé en silence.
     */
    const { cible, ancien } = verticalChoices();
    const joignables = [...cible, ...ancien].map((choice) => choice.id);
    expect(joignables.sort()).toEqual([...VERTICALS].sort());
  });

  it("les deux groupes séparent la cible de l'ancien découpage", () => {
    const { cible, ancien } = verticalChoices();
    // `autre` n'est pas un métier : c'est le refus de choisir, et il reste à
    // portée immédiate plutôt que rangé avec l'ancien découpage.
    expect(cible.map((c) => c.id).sort()).toEqual([...PIVOT_VERTICALS, "autre"].sort());
    expect(ancien.map((c) => c.id).sort()).toEqual(
      ["industrie_btp", "services", "negoce", "retail"].sort(),
    );
  });

  it("le choix est RÉVERSIBLE : rien ne disparaît une fois qu'on en est sorti", () => {
    // La version masquée était à sens unique — un tenant passé de
    // `industrie_btp` à `batiment` n'avait plus aucun moyen de revenir, alors
    // que le doc promet que « le patron reclassera lui-même ».
    const ids = verticalChoices();
    expect([...ids.cible, ...ids.ancien].map((c) => c.id)).toContain("industrie_btp");
  });
});
