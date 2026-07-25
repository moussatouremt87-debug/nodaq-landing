import { describe, expect, it } from "vitest";
import { allowedTiers, classify } from "../src/index.js";

describe("classify — deterministic rules", () => {
  it("flags a compact IBAN as confidentiel", async () => {
    const r = await classify({ text: "Virement vers FR7630006000011234567890189 demain" });
    expect(r).toMatchObject({ category: "confidentiel", decidedBy: "rules" });
    expect(r.signals).toContain("iban");
  });

  it("flags a LOWERCASE iban as confidentiel (case-insensitive rules)", async () => {
    const r = await classify({
      text: "article de blog avec fr7630006000011234567890189 dedans",
    });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("iban");
  });

  it("flags a spaced IBAN as confidentiel", async () => {
    const r = await classify({ text: "IBAN : FR76 3000 6000 0112 3456 7890 189" });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("iban");
  });

  it("flags a NIR (sécurité sociale) as confidentiel", async () => {
    const r = await classify({ text: "Assuré n° 1 85 05 78 006 084 36" });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("nir");
  });

  it("flags payroll keywords as confidentiel", async () => {
    const r = await classify({ text: "Voici le bulletin de paie de mars" });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("paie");
  });

  it("flags contract keywords as confidentiel", async () => {
    const r = await classify({ text: "Relis la clause de non-concurrence du contrat de travail" });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("contrat");
  });

  it("flags RIB keyword as confidentiel", async () => {
    const r = await classify({ text: "Le relevé d'identité bancaire du fournisseur est joint" });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("rib");
  });

  it("flags dense nominative PII (email + phone) as confidentiel", async () => {
    const r = await classify({
      text: "Contacte Jean Dupont, jean.dupont@exemple.fr, 06 12 34 56 78",
    });
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("pii-dense");
  });

  it("a single PII kind is NOT enough to be confidentiel", async () => {
    const r = await classify({ text: "Écris à contact@exemple.fr pour le devis" });
    expect(r.category).toBe("interne");
  });

  it("defaults business content to interne", async () => {
    const r = await classify({ text: "Prépare le compte-rendu de la réunion produit" });
    expect(r).toMatchObject({ category: "interne", decidedBy: "rules" });
  });

  it("public marker or hint yields non_sensible", async () => {
    const marker = await classify({ text: "Rédige un article de blog sur la facturation" });
    expect(marker.category).toBe("non_sensible");
    const hint = await classify({ text: "Texte générique", hints: { public: true } });
    expect(hint.category).toBe("non_sensible");
  });

  it("confidential rules WIN over public hints (no downgrade)", async () => {
    const r = await classify({
      text: "Publie l'IBAN FR7630006000011234567890189",
      hints: { public: true },
    });
    expect(r.category).toBe("confidentiel");
  });

  it("rejects invalid input (Zod)", async () => {
    await expect(classify({ text: "" })).rejects.toThrow();
  });
});

describe("classify — sovereign LLM fallback (fail-safe)", () => {
  it("uses the fallback verdict when parseable", async () => {
    const r = await classify(
      { text: "Contenu difficile à trancher", hints: { ambiguous: true } },
      { fallback: async () => " interne " },
    );
    expect(r).toMatchObject({ category: "interne", decidedBy: "llm" });
  });

  it("FAIL-SAFE: fallback error => confidentiel, never fail open", async () => {
    const r = await classify(
      { text: "Contenu difficile à trancher", hints: { ambiguous: true } },
      {
        fallback: async () => {
          throw new Error("LLM down");
        },
      },
    );
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("fail-safe");
  });

  it("FAIL-SAFE: unparseable fallback answer => confidentiel", async () => {
    const r = await classify(
      { text: "Contenu difficile à trancher", hints: { ambiguous: true } },
      { fallback: async () => "je ne sais pas trop" },
    );
    expect(r.category).toBe("confidentiel");
    expect(r.signals).toContain("fail-safe");
  });

  it("FAIL-SAFE: ambiguous without any fallback => confidentiel", async () => {
    const r = await classify({ text: "Contenu difficile à trancher", hints: { ambiguous: true } });
    expect(r.category).toBe("confidentiel");
  });

  it("rules keep priority over the fallback (no LLM call when a rule matches)", async () => {
    let called = false;
    const r = await classify(
      { text: "IBAN FR7630006000011234567890189", hints: { ambiguous: true } },
      {
        fallback: async () => {
          called = true;
          return "non_sensible";
        },
      },
    );
    expect(r.category).toBe("confidentiel");
    expect(called).toBe(false);
  });
});

describe("allowedTiers — routing policy", () => {
  it("confidentiel and interne never include frontier, whatever the tenant policy", () => {
    expect(allowedTiers("confidentiel", { frontierEnabled: true })).not.toContain("frontier");
    expect(allowedTiers("interne", { frontierEnabled: true })).not.toContain("frontier");
  });

  it("non_sensible includes frontier ONLY with tenant opt-in (default off)", () => {
    expect(allowedTiers("non_sensible")).not.toContain("frontier");
    expect(allowedTiers("non_sensible", { frontierEnabled: false })).not.toContain("frontier");
    expect(allowedTiers("non_sensible", { frontierEnabled: true })).toContain("frontier");
  });

  it("every category allows at least one sovereign tier", () => {
    for (const category of ["confidentiel", "interne", "non_sensible"] as const) {
      expect(allowedTiers(category)).toContain("sovereign-fast");
    }
  });
});
