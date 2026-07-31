import { describe, expect, it } from "vitest";
import {
  categoryForAccount,
  classifyAccount,
  COST_CATEGORIES,
  COST_RULES_VERSION,
  EXCLUDED_ACCOUNTS,
} from "../src/costCategories.js";

/*
 * Rattachement des comptes PCG aux postes de charge (2.8). Ce qui est testé :
 * qu'un compte ne se retrouve pas dans le mauvais poste (une charge directe
 * comptée en exploitation gonflerait la marge brute), et que les exclusions
 * soient DITES plutôt que silencieuses.
 */

describe("config", () => {
  it("versionnée, datée, et chaque poste porte son niveau", () => {
    expect(COST_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const category of COST_CATEGORIES) {
      expect(["direct", "exploitation"]).toContain(category.level);
      expect(category.accounts.length).toBeGreaterThan(0);
    }
  });

  it("chaque exclusion porte SA raison : un compte écarté sans motif se lit comme un oubli", () => {
    expect(EXCLUDED_ACCOUNTS.length).toBeGreaterThan(0);
    for (const excluded of EXCLUDED_ACCOUNTS) {
      expect(excluded.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("rattachement des comptes", () => {
  it("le préfixe le PLUS LONG gagne : 611 est de la sous-traitance, pas un service extérieur", () => {
    // Sans cette règle, une charge DIRECTE tomberait en exploitation et la
    // marge brute serait surévaluée — l'erreur exacte que le ticket combat.
    expect(categoryForAccount("6111")?.id).toBe("sous_traitance");
    expect(categoryForAccount("6132")?.id).toBe("services_exterieurs");
  });

  it("achats et marchandises sont des coûts DIRECTS", () => {
    expect(categoryForAccount("601000")?.level).toBe("direct");
    expect(categoryForAccount("607")?.level).toBe("direct");
  });

  it("les rabais obtenus (609) réduisent les achats, ils ne sont pas un poste à part", () => {
    expect(categoryForAccount("6091")?.id).toBe("achats");
  });

  it("les charges de personnel sont de l'exploitation", () => {
    expect(categoryForAccount("641100")?.id).toBe("main_oeuvre");
  });

  it("dotations, charges financières, exceptionnelles et IS : hors marge, par décision", () => {
    // 681 : amortissement ≠ décaissement (même garde qu'en 2.19).
    for (const account of ["681100", "661", "671", "695"]) {
      expect(categoryForAccount(account)).toBeNull();
    }
  });

  it("un compte hors classe 6 n'est jamais une charge", () => {
    for (const account of ["411000", "706", "2183"]) {
      expect(categoryForAccount(account)).toBeNull();
    }
  });

  it("EXCLU et NON RATTACHÉ sont deux choses différentes", () => {
    // Les confondre faisait disparaître une charge réelle en silence, et la
    // marge pouvait alors s'annoncer « complète » sur une base incomplète.
    expect(classifyAccount("681120").kind).toBe("exclu");
    // 603 = variation des stocks : une charge réelle, hors catalogue.
    expect(classifyAccount("603700").kind).toBe("non_rattache");
    expect(classifyAccount("608000").kind).toBe("non_rattache");
    expect(classifyAccount("607100").kind).toBe("poste");
    expect(classifyAccount("411000").kind).toBe("hors_charges");
  });

  it("PURE : deux appels identiques donnent le même rattachement", () => {
    expect(categoryForAccount("607100")).toEqual(categoryForAccount("607100"));
  });
});
