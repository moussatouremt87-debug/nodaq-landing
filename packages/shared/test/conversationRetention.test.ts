import { describe, expect, it } from "vitest";
import {
  CONVERSATION_RETENTION_DAYS,
  CONVERSATION_RETENTION_VERSION,
  conversationVerdict,
} from "../src/index.js";

/*
 * Rétention des transcriptions d'agent (art. 5.1.e).
 *
 * Ce que ces lignes contiennent : le fil complet, résultats d'outils compris —
 * noms de clients, montants dus, libellés de compte, coordonnées de prospects.
 * La donnée la plus concentrée du produit, dans sa forme la moins structurée.
 *
 * Ce qui rend le cas tranché : l'identifiant de conversation ne vit que dans un
 * `useRef` de l'écran de chat. Aucune route ne les liste, aucun écran ne les
 * affiche. Un rechargement de page rend le transcript DÉFINITIVEMENT illisible
 * — et rien ne l'effaçait.
 */

const NOW = new Date("2026-08-05T12:00:00.000Z");
const jours = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

describe("config versionnée datée", () => {
  it("porte une version datée", () => {
    expect(CONVERSATION_RETENTION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });
});

describe("l'âge se compte sur la dernière ACTIVITÉ", () => {
  it("une conversation encore dans son horizon est gardée", () => {
    const v = conversationVerdict({ updatedAt: jours(CONVERSATION_RETENTION_DAYS - 1) }, NOW);
    expect(v.action).toBe("garder");
  });

  it("une conversation dormante au-delà de l'horizon est SUPPRIMÉE", () => {
    const v = conversationVerdict({ updatedAt: jours(CONVERSATION_RETENTION_DAYS + 1) }, NOW);
    expect(v.action).toBe("supprimer");
    // Un refus comme une suppression est une RÉPONSE motivée.
    expect(v.reason).toContain("dormante");
  });

  it("une conversation reprise hier est vivante, même née il y a un an", () => {
    /*
     * La dater de sa création la ferait supprimer sous les doigts de
     * l'utilisateur : le runtime réécrit la ligne à chaque tour, donc une
     * conversation entretenue pendant des mois est ACTIVE, pas ancienne.
     */
    const v = conversationVerdict({ updatedAt: jours(1) }, NOW);
    expect(v.action).toBe("garder");
  });

  it("la borne est franche, pas approximative", () => {
    // Exactement l'horizon : encore dedans. Le strictement-plus-vieux sort.
    expect(conversationVerdict({ updatedAt: jours(CONVERSATION_RETENTION_DAYS) }, NOW).action).toBe(
      "supprimer",
    );
    const juste = new Date(NOW.getTime() - CONVERSATION_RETENTION_DAYS * 86_400_000 + 1);
    expect(conversationVerdict({ updatedAt: juste }, NOW).action).toBe("garder");
  });

  it("une conversation datée du FUTUR est gardée, jamais supprimée par erreur", () => {
    // Décalage d'horloge entre l'API et la base : l'âge devient négatif. Une
    // suppression sur un âge négatif détruirait une conversation en cours.
    const v = conversationVerdict({ updatedAt: new Date(NOW.getTime() + 3_600_000) }, NOW);
    expect(v.action).toBe("garder");
  });

  it("l'horizon est paramétrable — les tests n'attendent pas trente jours", () => {
    expect(conversationVerdict({ updatedAt: jours(2) }, NOW, 1).action).toBe("supprimer");
    expect(conversationVerdict({ updatedAt: jours(2) }, NOW, 5).action).toBe("garder");
  });
});
