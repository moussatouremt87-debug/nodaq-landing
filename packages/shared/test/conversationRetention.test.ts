import { describe, expect, it } from "vitest";
import {
  CONVERSATION_RETENTION_DAYS,
  CONVERSATION_RETENTION_VERSION,
  conversationCutoff,
} from "../src/index.js";

/*
 * Rétention des transcriptions d'agent (art. 5.1.e).
 *
 * Ce que ces lignes contiennent : le fil complet, résultats d'outils compris —
 * noms de clients, montants dus, libellés de compte, coordonnées de prospects.
 *
 * Ce qui rend le cas tranché : l'identifiant de conversation ne vit que dans un
 * `useRef` de l'écran de chat. Aucune route ne les liste, aucun écran ne les
 * affiche. Un rechargement de page rend le transcript DÉFINITIVEMENT illisible
 * — et rien ne l'effaçait.
 *
 * CE QUE CE FICHIER NE FAIT PLUS. Une première version portait un
 * `conversationVerdict` réimplémentant en TypeScript la règle que le balayage
 * exécute en SQL. Les deux divergeaient sur la borne exacte, et ces tests
 * étaient verts contre du code que la production n'exécutait pas. Une règle
 * « versionnée datée » qui s'applique à deux endroits n'est pas une règle,
 * c'est deux règles. Il ne reste que le seuil — celui que le SQL consomme.
 */

const NOW = new Date("2026-08-05T12:00:00.000Z");

describe("config versionnée datée", () => {
  it("porte une version datée", () => {
    expect(CONVERSATION_RETENTION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });
});

describe("le seuil de dormance", () => {
  it("recule d'exactement l'horizon", () => {
    const seuil = conversationCutoff(NOW);
    expect(NOW.getTime() - seuil.getTime()).toBe(CONVERSATION_RETENTION_DAYS * 86_400_000);
  });

  it("est paramétrable — les tests n'attendent pas trente jours", () => {
    expect(NOW.getTime() - conversationCutoff(NOW, 1).getTime()).toBe(86_400_000);
  });

  it("un horizon nul rend l'instant présent, jamais le futur", () => {
    // Garde-fou d'un réglage à zéro : le seuil ne doit pas dépasser `now`,
    // sinon le balayage emporterait une conversation en cours d'écriture.
    expect(conversationCutoff(NOW, 0).getTime()).toBe(NOW.getTime());
  });
});
