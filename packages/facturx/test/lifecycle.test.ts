import { describe, expect, it } from "vitest";
import {
  isRejection,
  isValidTransition,
  LIFECYCLE_RULES_VERSION,
  normalizeStatus,
  STATUS_LABELS,
  SUBMISSION_STATUSES,
  TERMINAL_STATUSES,
} from "../src/index.js";

/*
 * Cycle de vie e-invoicing (2.4) : le vocabulaire de statuts est NORMATIF —
 * il est partagé par l'émetteur, la plateforme, le destinataire et
 * l'administration. En inventer un casserait le rapprochement.
 */

describe("statuts du cycle de vie", () => {
  it("config versionnée, chaque statut libellé", () => {
    expect(LIFECYCLE_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const status of SUBMISSION_STATUSES) {
      expect(STATUS_LABELS[status].length).toBeGreaterThan(3);
    }
  });
});

describe("isValidTransition", () => {
  it("avance : les sauts en avant sont tolérés (un webhook peut manquer)", () => {
    expect(isValidTransition("prete", "deposee")).toBe(true);
    expect(isValidTransition("deposee", "recue")).toBe(true);
    // Saut direct : la plateforme peut ne pas notifier chaque étape.
    expect(isValidTransition("deposee", "approuvee")).toBe(true);
  });

  it("JAMAIS en arrière : un webhook rejoué ne réécrit pas l'histoire", () => {
    expect(isValidTransition("approuvee", "deposee")).toBe(false);
    expect(isValidTransition("recue", "prete")).toBe(false);
    // Ni sur place : un doublon n'est pas une transition.
    expect(isValidTransition("recue", "recue")).toBe(false);
  });

  it("statut terminal : seul l'encaissement peut suivre une décision", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(isValidTransition(terminal, "deposee")).toBe(false);
    }
    expect(isValidTransition("refusee", "encaissee")).toBe(true);
    // Encaissée est définitif.
    expect(isValidTransition("encaissee", "approuvee")).toBe(false);
    expect(isValidTransition("encaissee", "encaissee")).toBe(false);
  });

  it("une erreur de transmission peut être suivie d'un nouveau dépôt", () => {
    expect(isValidTransition("erreur", "deposee")).toBe(true);
    expect(isValidTransition("erreur", "approuvee")).toBe(false);
    expect(isValidTransition("deposee", "erreur")).toBe(true);
  });

  it("`erreur` ne peut PAS survenir après prise en charge de la plateforme", () => {
    // Sinon le couple (X -> erreur -> deposee) rouvrirait le cycle d'une
    // facture déjà traitée, et afficherait « erreur de transmission » sur une
    // facture en réalité approuvée.
    for (const advanced of ["recue", "prise_en_charge", "approuvee", "encaissee"] as const) {
      expect(isValidTransition(advanced, "erreur")).toBe(false);
    }
  });

  it("rejet : distingue le refus du CLIENT et le rejet de la PLATEFORME", () => {
    expect(isRejection("refusee")).toBe(true);
    expect(isRejection("rejetee")).toBe(true);
    expect(isRejection("approuvee_partiellement")).toBe(false);
    // Une erreur de transport n'est PAS un verdict de la plateforme.
    expect(isRejection("erreur")).toBe(false);
  });
});

describe("normalizeStatus", () => {
  it("accepte les variantes usuelles des plateformes", () => {
    expect(normalizeStatus("DEPOSEE")).toBe("deposee");
    expect(normalizeStatus("Déposée")).toBe("deposee");
    expect(normalizeStatus("prise en charge")).toBe("prise_en_charge");
    expect(normalizeStatus("approved")).toBe("approuvee");
    expect(normalizeStatus("rejected")).toBe("rejetee");
  });

  it("statut inconnu : null, jamais une supposition", () => {
    expect(normalizeStatus("en_cours_de_traitement_special")).toBeNull();
    expect(normalizeStatus("")).toBeNull();
  });
});
