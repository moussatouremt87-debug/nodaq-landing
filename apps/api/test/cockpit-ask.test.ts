import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Cockpit conversationnel (2.5). Le modèle est BOUCHONNÉ : il émet la requête
 * STRUCTURÉE qu'un vrai modèle produirait, et ce qui est testé c'est la
 * chaîne d'exécution — catalogue fermé, gating par rôle, chiffres réels.
 *
 * Le point qui compte : un membre qui demande le chiffre d'affaires par
 * client doit être REFUSÉ, même si le modèle formule parfaitement la requête.
 */

/** Ce que le faux modèle décide d'appeler (ou de répondre). */
let nextToolCall: { name: string; args: unknown } | null = null;
let sawToolResult: string | null = null;

const fakeLiteLLM = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw) as {
      messages?: { role: string; content?: unknown; tool_call_id?: string }[];
    };
    const messages = body.messages ?? [];
    const toolMessage = [...messages].reverse().find((message) => message.role === "tool");
    res.writeHead(200, { "content-type": "application/json" });

    // Deuxième tour : le résultat de l'outil est là, on « répond ».
    if (toolMessage) {
      sawToolResult = String(toolMessage.content ?? "");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `Voici le résultat : ${sawToolResult}` } }],
        }),
      );
      return;
    }
    if (nextToolCall) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: nextToolCall.name,
                      arguments: JSON.stringify(nextToolCall.args),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "Je ne sais pas." } }] }));
  });
});

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;
const RUN = Date.now().toString(36);

function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

async function signup(email: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "a-strong-password-123", name },
  });
  expect(res.statusCode).toBe(200);
  return cookiesOf(res);
}

async function ask(question: string, cookie: string): Promise<{ answer: string; tools: string[] }> {
  const res = await app.inject({
    method: "POST",
    url: "/cockpit/ask",
    headers: { cookie },
    payload: { question },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { answer: string; tools: string[] };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeLiteLLM.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLLM.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test-master";

  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`ask-owner-${RUN}@example.com`, "Ask Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Ask ${RUN}`, slug: `org-ask-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`ask-member-${RUN}@example.com`, "Ask Member");
  const memberId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: memberCookie } })
  ).json().userId as string;
  await admin.membership.create({ data: { tenantId: orgId, userId: memberId, role: "member" } });
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: memberCookie },
    payload: { organizationId: orgId },
  });

  // PIVOT (ADR-007) : le module `stocks` est HORS SOCLE — éteint par défaut.
  // Ces tests portent sur la doctrine du cockpit conversationnel (refus
  // motivés, gating de champ), pas sur les défauts produit : ils disent donc
  // explicitement dans quel état de modules ils se placent.
  const moduleOn = await app.inject({
    method: "PUT",
    url: "/modules/stocks",
    headers: { cookie: ownerCookie },
    payload: { active: true },
  });
  expect(moduleOn.statusCode).toBe(200);

  // Données réelles du tenant : deux articles en stock.
  await admin.stockItem.createMany({
    data: [
      { tenantId: orgId, name: `Câble 3G2.5 ${RUN}`, quantity: 120, unitCostCents: 250 },
      { tenantId: orgId, name: `Disjoncteur 20A ${RUN}`, quantity: 30, unitCostCents: 900 },
    ],
  });
}, 60_000);

afterAll(async () => {
  fakeLiteLLM.close();
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("cockpit conversationnel", () => {
  it("répond sur les données RÉELLES du tenant, et dit d'où vient le chiffre", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: { dataset: "stocks", aggregate: "sum", measure: "quantite" },
    };
    const result = await ask("Combien d'articles en stock au total ?", ownerCookie);
    expect(result.tools).toContain("query_business_data");
    // 120 + 30, lus en base — pas un chiffre inventé par le modèle.
    expect(sawToolResult).toContain('"value":150');
    expect(result.answer).toContain("150");
  });

  it("un MEMBRE ne peut pas atteindre un jeu de données de dirigeant", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: { dataset: "factures_clients", aggregate: "sum", measure: "montant", groupBy: "client" },
    };
    await ask("Quel est mon chiffre d'affaires par client ?", memberCookie);
    // Refus MOTIVÉ renvoyé au modèle — et aucune donnée de facturation.
    expect(sawToolResult).toContain("refused");
    expect(sawToolResult).toContain("dirigeant");
    expect(sawToolResult).not.toContain("customerName");
  });

  it("un champ réservé au dirigeant est refusé même sur un dataset ouvert", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: { dataset: "stocks", aggregate: "sum", measure: "cout_unitaire" },
    };
    await ask("Combien vaut mon stock ?", memberCookie);
    expect(sawToolResult).toContain("refused");
    expect(sawToolResult).toContain("dirigeant");
  });

  it("un champ hors catalogue est refusé : pas de colonne lue au hasard", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: {
        dataset: "stocks",
        aggregate: "count",
        filters: [{ field: "tenantId", op: "neq", value: "autre" }],
      },
    };
    await ask("Montre-moi les stocks des autres", ownerCookie);
    expect(sawToolResult).toContain("refused");
    expect(sawToolResult).toContain("inconnu");
  });

  it("le regroupement rend des lignes chiffrées, bornées", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: { dataset: "stocks", aggregate: "sum", measure: "quantite", groupBy: "article" },
    };
    await ask("Quantité par article ?", ownerCookie);
    expect(sawToolResult).toContain(`Câble 3G2.5 ${RUN}`);
    expect(sawToolResult).toContain('"truncated":false');
  });

  it("compte groupé : le groupe « non renseigné » n'est pas relégué", async () => {
    // Trier un `count` sur une colonne NULLABLE compterait les non-nuls : le
    // groupe sans référence aurait un compte de 0 et sauterait à la coupe.
    nextToolCall = {
      name: "query_business_data",
      args: { dataset: "stocks", aggregate: "count", groupBy: "reference" },
    };
    await ask("Combien d'articles par référence ?", ownerCookie);
    expect(sawToolResult).not.toContain("refused");
    // Les deux articles ont une référence nulle : ils forment UN groupe de 2,
    // et ce groupe doit être là.
    expect(sawToolResult).toContain('"group":null');
    expect(sawToolResult).toContain('"value":2');
  });

  it("filtre sur un TEXTE qui ressemble à une date reste un texte", async () => {
    // « 2026-01-15 » peut être un numéro de pièce : le convertir en date le
    // rendrait introuvable, et le zéro passerait pour un fait.
    nextToolCall = {
      name: "query_business_data",
      args: {
        dataset: "stocks",
        aggregate: "count",
        filters: [{ field: "article", op: "contains", value: "2026-01-15" }],
      },
    };
    await ask("Combien d'articles nommés 2026-01-15 ?", ownerCookie);
    expect(sawToolResult).not.toContain("refused");
    expect(sawToolResult).toContain('"value":0');
  });

  it("période ET filtre sur la même date : refus explicite plutôt qu'écrasement", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: {
        dataset: "documents",
        aggregate: "count",
        filters: [{ field: "date_ajout", op: "gte", value: "2020-01-01" }],
        from: "2026-01-01",
      },
    };
    await ask("Combien de documents ?", ownerCookie);
    expect(sawToolResult).toContain("refused");
    expect(sawToolResult).toContain("déjà filtré");
  });

  it("une somme sur zéro ligne n'est pas zéro", async () => {
    nextToolCall = {
      name: "query_business_data",
      args: {
        dataset: "stocks",
        aggregate: "sum",
        measure: "quantite",
        filters: [{ field: "article", op: "eq", value: "article-qui-nexiste-pas" }],
      },
    };
    await ask("Combien de cet article ?", ownerCookie);
    expect(sawToolResult).toContain('"value":null');
    expect(sawToolResult).toContain('"rows":0');
  });

  it("question vide ou démesurée : 400", async () => {
    for (const question of ["", "x".repeat(600)]) {
      const res = await app.inject({
        method: "POST",
        url: "/cockpit/ask",
        headers: { cookie: ownerCookie },
        payload: { question },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("réponse jamais mise en cache", async () => {
    nextToolCall = null;
    const res = await app.inject({
      method: "POST",
      url: "/cockpit/ask",
      headers: { cookie: ownerCookie },
      payload: { question: "Bonjour" },
    });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("module éteint : le chat REFUSE le jeu de données, avec un motif", async () => {
    // La page et les outils d'un module éteint disparaissent — le chat, lui,
    // garde `query_business_data` (outil du cœur). Sans gating du catalogue,
    // il resterait une porte ouverte sur un module désactivé.
    const off = await app.inject({
      method: "PUT",
      url: "/modules/stocks",
      headers: { cookie: ownerCookie },
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);
    try {
      nextToolCall = {
        name: "query_business_data",
        args: { dataset: "stocks", aggregate: "count" },
      };
      await ask("Combien d'articles en stock au total ?", ownerCookie);
      // Un REFUS motivé, jamais un zéro qui se lirait « vous n'avez pas de
      // stock » alors que les articles sont bien là.
      expect(sawToolResult).toContain("refused");
      expect(sawToolResult).toContain("désactivé");
    } finally {
      await app.inject({
        method: "PUT",
        url: "/modules/stocks",
        headers: { cookie: ownerCookie },
        payload: { active: true },
      });
    }
  });
});
