import { describe, expect, it } from "vitest";
import {
  auditRgpdRegister,
  LEGAL_BASES,
  PROCESSING_TEMPLATES,
  RGPD_REGISTER_VERSION,
} from "../src/rgpdRegister.js";

/*
 * Assistant RGPD (ticket 3.9) — modèles de traitements PME en CONFIG
 * VERSIONNÉE DATÉE sourcée (doctrine 2.19/3.7, registre simplifié CNIL) +
 * moteur PUR d'audit du registre : chaque alerte est justifiée, jamais un
 * droit inventé. Information générale, PAS un conseil juridique ni un DPO —
 * le label le dit en permanence.
 */

describe("modèles de traitements (registre simplifié CNIL)", () => {
  it("versionnés, datés, chaque modèle sourcé avec base légale et durée", () => {
    expect(RGPD_REGISTER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PROCESSING_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    for (const template of PROCESSING_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.purpose.length).toBeGreaterThan(10);
      expect(LEGAL_BASES).toContain(template.legalBasis);
      expect(template.retention.length).toBeGreaterThan(5);
      expect(template.source.url).toMatch(/^https:\/\//);
      expect(template.dataCategories.length).toBeGreaterThan(0);
      expect(template.dataSubjects.length).toBeGreaterThan(0);
    }
    // La paie est en obligation légale, la facturation porte ses 10 ans.
    const paie = PROCESSING_TEMPLATES.find((t) => t.id === "paie");
    expect(paie?.legalBasis).toBe("obligation_legale");
    const facturation = PROCESSING_TEMPLATES.find((t) => t.id === "facturation-clients");
    expect(facturation?.retention).toContain("10 ans");
  });
});

describe("auditRgpdRegister", () => {
  const base = {
    name: "Paie",
    legalBasis: "obligation_legale",
    dataCategories: ["identite", "financier"],
    retention: "5 ans (bulletins)",
    sensitiveData: false,
  };

  it("registre vide : alerte art. 30, jamais un silence", () => {
    const audit = auditRgpdRegister([]);
    expect(audit.issues.some((i) => i.code === "registre_vide" && i.severity === "alerte")).toBe(
      true,
    );
    expect(audit.label).toContain("conseil juridique");
    expect(audit.version).toBe(RGPD_REGISTER_VERSION);
  });

  it("durée de conservation manquante : alerte nominative", () => {
    const audit = auditRgpdRegister([{ ...base, retention: "  " }]);
    const issue = audit.issues.find((i) => i.code === "duree_manquante");
    expect(issue?.severity).toBe("alerte");
    expect(issue?.activityName).toBe("Paie");
  });

  it("base légale invalide ou données sensibles sur intérêt légitime : signalés", () => {
    const badBasis = auditRgpdRegister([{ ...base, legalBasis: "envie" }]);
    expect(badBasis.issues.some((i) => i.code === "base_invalide")).toBe(true);

    const sensitive = auditRgpdRegister([
      { ...base, name: "Santé au travail", sensitiveData: true, legalBasis: "interet_legitime" },
    ]);
    expect(sensitive.issues.some((i) => i.code === "base_inadaptee")).toBe(true);
    // Données sensibles = rappel art. 9 même avec une base correcte.
    const info = auditRgpdRegister([
      { ...base, name: "Santé", sensitiveData: true, legalBasis: "obligation_legale" },
    ]);
    expect(info.issues.some((i) => i.code === "donnees_sensibles" && i.severity === "attention")).toBe(true);
  });

  it("catégorie santé sans drapeau sensible : incohérence remontée", () => {
    const audit = auditRgpdRegister([
      { ...base, name: "Suivi médical", dataCategories: ["sante"], sensitiveData: false },
    ]);
    expect(audit.issues.some((i) => i.code === "incoherence_sensible")).toBe(true);
  });

  it("registre propre : zéro alerte, uniquement le décompte", () => {
    const audit = auditRgpdRegister([base]);
    expect(audit.issues.filter((i) => i.severity === "alerte")).toEqual([]);
    expect(audit.activityCount).toBe(1);
  });
});
