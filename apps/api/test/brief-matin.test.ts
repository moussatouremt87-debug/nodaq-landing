import { describe, expect, it } from "vitest";
import {
  BRIEF_RULES_VERSION,
  composeMorningBrief,
  type BriefInput,
} from "../src/briefMatin.js";

/*
 * F5 — le brief du matin.
 *
 * La question posée à chaque cas : « à 7 h, sur un chantier, cette ligne
 * mérite-t-elle d'être lue ? » Un brief qu'on apprend à survoler ne sert plus à
 * rien — donc le remplissage est testé aussi sévèrement que les oublis.
 */

const RIEN: BriefInput = {
  pendingActions: 0,
  affairesEnPerte: null,
  budgetsDepasses: null,
  echeances: null,
  impayes: null,
  stockSousSeuil: null,
  documentsAVerifier: 0,
  blindSpots: [],
};

/** Échéance à J+`days`, montant déclaré, date certaine sauf mention. */
const echeance = (days: number, amountCents: number | null = null, approx = false) => ({
  days,
  amountCents,
  dateIsApproximate: approx,
});

describe("config versionnée", () => {
  it("porte une version datée", () => {
    expect(BRIEF_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("une matinée calme est un brief valide", () => {
  it("rien à signaler => `calme`, jamais une liste vide déguisée en brief", () => {
    // Meubler une matinée calme apprend au patron à ne plus lire, ce qui tue la
    // feature plus sûrement qu'une journée vide.
    const brief = composeMorningBrief(RIEN);
    expect(brief.kind).toBe("calme");
    expect("items" in brief).toBe(false);
  });

  it("calme ne veut pas dire AVEUGLE : les angles morts restent dits", () => {
    // « Rien d'urgent » alors qu'on n'a pas pu regarder les impayés serait le
    // pire mensonge possible sur cet écran-là.
    const brief = composeMorningBrief({
      ...RIEN,
      blindSpots: [{ area: "impayés", why: "aucun facturier connecté" }],
    });
    expect(brief.kind).toBe("calme");
    expect(brief.blindSpots).toHaveLength(1);
    expect(brief.blindSpots[0]?.why).toContain("facturier");
  });
});

describe("ce qui remonte en URGENT — de l'argent qui part ou ne rentre pas", () => {
  it("une affaire en perte passe devant tout le reste", () => {
    const brief = composeMorningBrief({
      ...RIEN,
      pendingActions: 4,
      documentsAVerifier: 9,
      affairesEnPerte: { count: 1, worst: { cents: -150_000, basis: "exact" } },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items[0]?.kind).toBe("affaire_en_perte");
    expect(brief.items[0]?.severity).toBe("urgent");
    expect(brief.items[0]?.amountCents).toBe(-150_000);
    // Une seule affaire, marge exacte : rien à nuancer.
    expect(brief.items[0]?.amountNote).toBeNull();
  });

  it("un montant issu d'un PLAFOND ne se rend jamais comme une marge exacte", () => {
    // « au mieux −1 500 € » veut dire que la réalité est PIRE. Rendu nu, ce
    // chiffre se lit comme la perte constatée — et rassure à tort.
    const brief = composeMorningBrief({
      ...RIEN,
      affairesEnPerte: { count: 1, worst: { cents: -150_000, basis: "au_mieux" } },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items[0]?.amountNote).toContain("au mieux");
    expect(brief.items[0]?.amountNote).toContain("pire");
  });

  it("sur PLUSIEURS affaires, le montant est dit « la pire », jamais un total", () => {
    const brief = composeMorningBrief({
      ...RIEN,
      affairesEnPerte: { count: 3, worst: { cents: -150_000, basis: "exact" } },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items[0]?.amountNote).toContain("la pire");
  });

  it("des impayés remontent avec leur montant EXIGIBLE", () => {
    const brief = composeMorningBrief({
      ...RIEN,
      impayes: { count: 3, totalCents: 803_000 },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    const impayes = brief.items.find((item) => item.kind === "impayes");
    expect(impayes?.severity).toBe("urgent");
    expect(impayes?.amountCents).toBe(803_000);
  });

  it("une échéance à trois jours est urgente, à sept elle est une attention", () => {
    const urgent = composeMorningBrief({
      ...RIEN,
      echeances: { enRetard: null, prochaine: echeance(2, 120_000) },
    });
    if (urgent.kind !== "brief") throw new Error("cas attendu");
    expect(urgent.items[0]?.severity).toBe("urgent");

    const attention = composeMorningBrief({
      ...RIEN,
      echeances: { enRetard: null, prochaine: echeance(6, 120_000) },
    });
    if (attention.kind !== "brief") throw new Error("cas attendu");
    expect(attention.items[0]?.severity).toBe("attention");
  });

  it("une échéance lointaine ne remonte PAS : ce n'est pas l'affaire du matin", () => {
    const brief = composeMorningBrief({
      ...RIEN,
      echeances: { enRetard: null, prochaine: echeance(40, 120_000) },
    });
    expect(brief.kind).toBe("calme");
  });

  it("une échéance DÉJÀ passée est dite « en retard », jamais « due aujourd'hui »", () => {
    // Le retard n'est pas une échéance proche : la pénalité court déjà, et
    // afficher « due aujourd'hui » ferait croire qu'il reste la journée.
    const brief = composeMorningBrief({
      ...RIEN,
      echeances: { enRetard: echeance(12, 120_000), prochaine: null },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items[0]?.kind).toBe("echeance_en_retard");
    expect(brief.items[0]?.severity).toBe("urgent");
    expect(brief.items[0]?.label).toContain("retard de 12 jours");
  });

  it("un retard ne MASQUE pas la prochaine échéance : deux lignes, deux problèmes", () => {
    // Le bug d'origine : une seule case, prise par la plus ancienne, laissait
    // le brief muet sur la CA3 due après-demain.
    const brief = composeMorningBrief({
      ...RIEN,
      echeances: { enRetard: echeance(55, null), prochaine: echeance(2, 90_000) },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items.map((item) => item.kind)).toEqual([
      "echeance_en_retard",
      "echeance_proche",
    ]);
  });

  it("une date APPROXIMATIVE ne se rend jamais comme une date certaine", () => {
    // La date d'une CA3 dépend du SIREN : le calendrier rend la borne basse de
    // la fenêtre légale. « dans 2 jours » y serait une certitude inventée.
    const brief = composeMorningBrief({
      ...RIEN,
      echeances: { enRetard: null, prochaine: echeance(2, null, true) },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items[0]?.label).toContain("espace professionnel");
  });
});

describe("l'ordre est fixe", () => {
  it("urgent, puis attention, puis info — et stable à sévérité égale", () => {
    // Un ordre qui bouge d'un matin à l'autre donne l'impression que quelque
    // chose a changé alors que rien n'a bougé.
    const input: BriefInput = {
      ...RIEN,
      documentsAVerifier: 2,
      pendingActions: 5,
      stockSousSeuil: 1,
      impayes: { count: 1, totalCents: 50_000 },
      budgetsDepasses: 2,
    };
    const first = composeMorningBrief(input);
    const second = composeMorningBrief(input);
    if (first.kind !== "brief" || second.kind !== "brief") throw new Error("cas attendu");

    const severities = first.items.map((item) => item.severity);
    expect(severities).toEqual([...severities].sort((a, b) =>
      ["urgent", "attention", "info"].indexOf(a) - ["urgent", "attention", "info"].indexOf(b),
    ));
    // Deux compositions identiques se lisent à l'identique.
    expect(second.items.map((i) => i.kind)).toEqual(first.items.map((i) => i.kind));
    expect(first.items[first.items.length - 1]?.kind).toBe("documents_a_verifier");
  });
});

describe("chaque ligne mène quelque part", () => {
  it("toutes les lignes portent un lien : une alerte sans action est une anxiété", () => {
    const brief = composeMorningBrief({
      ...RIEN,
      pendingActions: 1,
      documentsAVerifier: 1,
      stockSousSeuil: 1,
      budgetsDepasses: 1,
      impayes: { count: 1, totalCents: 1 },
      affairesEnPerte: { count: 1, worst: { cents: -1, basis: "exact" } },
      echeances: { enRetard: echeance(4, 1), prochaine: echeance(1, 1) },
    });
    if (brief.kind !== "brief") throw new Error("cas attendu");
    expect(brief.items).toHaveLength(8);
    for (const item of brief.items) {
      expect(item.href).toMatch(/^\//);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("accorde le singulier et le pluriel — on lit ça tous les matins", () => {
    const un = composeMorningBrief({ ...RIEN, pendingActions: 1 });
    const plusieurs = composeMorningBrief({ ...RIEN, pendingActions: 3 });
    if (un.kind !== "brief" || plusieurs.kind !== "brief") throw new Error("cas attendu");
    expect(un.items[0]?.label).toBe("1 action attend votre validation");
    expect(plusieurs.items[0]?.label).toBe("3 actions attendent votre validation");
  });
});

describe("zéro n'est pas une nouvelle", () => {
  it("un domaine à zéro ne produit AUCUNE ligne", () => {
    const brief = composeMorningBrief({
      ...RIEN,
      impayes: { count: 0, totalCents: 0 },
      affairesEnPerte: { count: 0, worst: { cents: 0, basis: "exact" } },
      budgetsDepasses: 0,
      stockSousSeuil: 0,
      // Échéancier REGARDÉ et vide : ni ligne, ni angle mort.
      echeances: { enRetard: null, prochaine: null },
    });
    // « 0 impayé » est du bruit : on ne le dit pas, on ne l'affiche pas.
    expect(brief.kind).toBe("calme");
  });

  it("« regardé et vide » et « pas regardé » ne se confondent pas", () => {
    // Zéro impayé => rien à dire. Impayés NON regardés => angle mort déclaré.
    const vide = composeMorningBrief({ ...RIEN, impayes: { count: 0, totalCents: 0 } });
    expect(vide.blindSpots).toHaveLength(0);

    const aveugle = composeMorningBrief({
      ...RIEN,
      impayes: null,
      blindSpots: [{ area: "impayés", why: "aucun facturier connecté" }],
    });
    expect(aveugle.blindSpots).toHaveLength(1);
  });
});
