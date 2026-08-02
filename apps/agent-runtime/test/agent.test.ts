import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { ComptaAgent } from "../src/agent.js";
import type { AgentEvent } from "../src/agent.js";
import { MODULES } from "@nodaq/shared";
import { buildToolset, OWNER_ONLY_TOOLS } from "../src/tools.js";
import { createLangfuseTracer } from "../src/tracing.js";
import type { AgentRunTrace, AgentTracer } from "../src/tracing.js";

/**
 * The ticket's key deliverables:
 *  - PROVENANCE: the agent cannot act on another tenant, even by injecting a
 *    tenantId into tool arguments (the 1.2/1.3 follow-up, closed here);
 *  - HUMAN-IN-THE-LOOP: write tools prepare a pending_action, never execute;
 *  - SOVEREIGNTY: every loop iteration goes to a sovereign group;
 *  - resume: conversations persist and resume under RLS.
 */

const OTHER_TENANT = "99999999-8888-4777-a666-555555555555";

// ── Scripted fake LiteLLM ───────────────────────────────────────────────────────
interface RecordedModelCall {
  model: string;
  hasTools: boolean;
  messageCount: number;
}
const modelCalls: RecordedModelCall[] = [];
let script: object[] = [];
let scriptIndex = 0;

const fakeLiteLlm = createServer((req, res) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw) as { model: string; tools?: unknown[]; messages: unknown[] };
    modelCalls.push({
      model: body.model,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      messageCount: body.messages.length,
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (!body.tools || body.tools.length === 0) {
      // route() text call from inside draft_dunning: return the email draft.
      res.end(
        JSON.stringify({ choices: [{ message: { content: "Bonjour, facture en retard..." } }] }),
      );
      return;
    }
    const step = script[scriptIndex] ?? { content: "Fini." };
    scriptIndex++;
    res.end(JSON.stringify({ choices: [{ message: step }] }));
  });
});

// ── Fake RAG service: records the tenantId it actually receives ─────────────────
const ragRequests: { tenantId: string; query: string }[] = [];
const fakeRag = createServer((req, res) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw) as { tenantId: string; query: string };
    ragRequests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { content: "Procédure de relance: rappel à J+7.", score: 0.9, documentId: "d1", source: "UPLOAD", metadata: {} },
      ]),
    );
  });
});

// ── Fake Pennylane/Qonto for the connectors behind draft_dunning ────────────────
const fakeSaas = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if ((req.url ?? "").startsWith("/customer_invoices")) {
    res.end(
      JSON.stringify({
        items: [
          {
            id: "inv-42",
            invoice_number: "F-2026-042",
            amount: "1200.00",
            currency: "EUR",
            date: "2026-05-01",
            deadline: "2026-06-01",
            status: "late",
          },
        ],
      }),
    );
  } else {
    res.end("{}");
  }
});

// ── Fake Langfuse ingestion endpoint: records raw trace bodies ──────────────────
const langfuseBodies: string[] = [];
const fakeLangfuse = createServer((req, res) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", () => {
    langfuseBodies.push(raw);
    res.writeHead(207, { "content-type": "application/json" });
    res.end("{}");
  });
});

let admin: PrismaClient;
let tenantId: string;
const vaultEntries: Record<string, string> = {};
const vault = { get: (name: string) => Promise.resolve(vaultEntries[name]) };

function agent(tracer?: AgentTracer): ComptaAgent {
  const saasBase = `http://127.0.0.1:${(fakeSaas.address() as AddressInfo).port}`;
  return new ComptaAgent({
    tenantId,
    requestedBy: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    secretProvider: vault,
    pennylaneBaseUrl: saasBase,
    qontoBaseUrl: saasBase,
    ragBaseUrl: `http://127.0.0.1:${(fakeRag.address() as AddressInfo).port}`,
    ragToken: "test-rag-token",
    ...(tracer ? { tracer } : {}),
  });
}

beforeAll(async () => {
  for (const server of [fakeLiteLlm, fakeRag, fakeSaas, fakeLangfuse]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLlm.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test";

  admin = createAdminClient();
  await admin.pendingAction.deleteMany({ where: { tenant: { name: "Agent T" } } });
  await admin.agentConversation.deleteMany({ where: { tenant: { name: "Agent T" } } });
  await admin.connector.deleteMany({ where: { tenant: { name: "Agent T" } } });
  await admin.tenant.deleteMany({ where: { name: "Agent T" } });
  tenantId = (await admin.tenant.create({ data: { name: "Agent T" } })).id;
  vaultEntries[`connector/${tenantId}/pennylane`] = JSON.stringify({ apiKey: "pk-t" });
  vaultEntries[`connector/${tenantId}/qonto`] = JSON.stringify({
    organizationSlug: "org-t",
    secretKey: "sk-q",
  });
  await withTenant(tenantId, (tx) =>
    tx.connector.createMany({
      data: [
        { tenantId, type: "pennylane", credentialsRef: `connector/${tenantId}/pennylane` },
        { tenantId, type: "qonto", credentialsRef: `connector/${tenantId}/qonto` },
      ],
    }),
  );
});

afterAll(async () => {
  fakeLiteLlm.close();
  fakeRag.close();
  fakeSaas.close();
  fakeLangfuse.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

beforeEach(() => {
  modelCalls.length = 0;
  ragRequests.length = 0;
  langfuseBodies.length = 0;
  scriptIndex = 0;
  script = [];
});

/**
 * Active TOUS les modules du catalogue pour ce tenant.
 *
 * Depuis le pivot (ADR-007), une partie du catalogue est HORS SOCLE : éteinte
 * par défaut. Les tests ci-dessous portent sur le gate de RÔLE et sur la
 * dérive de nommage des outils — pas sur les défauts produit. Ils doivent donc
 * dire explicitement dans quel état de modules ils se placent, sinon ils
 * changeront de sens au prochain arbitrage produit.
 */
async function enableAllModules(): Promise<void> {
  const overrides = Object.fromEntries(MODULES.map((module) => [module.id, true]));
  await withTenant(tenantId, (tx) =>
    tx.tenantProfile.upsert({
      where: { tenantId },
      create: { tenantId, moduleOverrides: overrides },
      update: { moduleOverrides: overrides },
    }),
  );
}

async function clearModuleOverrides(): Promise<void> {
  await withTenant(tenantId, (tx) => tx.tenantProfile.deleteMany({}));
}

describe("ComptaAgent — the full loop", () => {
  it("PROVENANCE + HITL + SOVEREIGNTY in one conversation", async () => {
    // The (adversarial) model injects a foreign tenantId into every tool call.
    script = [
      {
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "rag_search",
              arguments: JSON.stringify({ query: "procédure de relance", tenantId: OTHER_TENANT }),
            },
          },
        ],
      },
      {
        content: null,
        tool_calls: [
          {
            id: "c2",
            type: "function",
            function: {
              name: "draft_dunning",
              arguments: JSON.stringify({ invoiceId: "inv-42", tenantId: OTHER_TENANT }),
            },
          },
        ],
      },
      { content: "Relance préparée, en attente de validation humaine." },
    ];

    const events: AgentEvent[] = [];
    const result = await agent().run("Prépare les relances des factures en retard", {
      onEvent: (e) => events.push(e),
    });

    // PROVENANCE 1: rag_search hit the RAG service with the BOUND tenant,
    // despite the injected tenantId in the tool arguments.
    expect(ragRequests).toHaveLength(1);
    expect(ragRequests[0]?.tenantId).toBe(tenantId);

    // PROVENANCE 2 + HITL: the pending_action landed in the BOUND tenant,
    // status pending, no validator — and nowhere else.
    const mine = await withTenant(tenantId, (tx) =>
      tx.pendingAction.findMany({ where: { type: "send_dunning" } }),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: "pending",
      validatedBy: null,
      tenantId,
      employee: "compta", // audit attribution: prepared by the virtual employee
    });

    // SOVEREIGNTY: every model call (loop iterations + inner dunning draft)
    // went to a sovereign group.
    expect(modelCalls.length).toBeGreaterThanOrEqual(4);
    expect(modelCalls.every((c) => c.model === "sovereign-fast")).toBe(true);

    // The final answer surfaced, and tool events carry names only.
    expect(result.answer).toContain("en attente de validation");
    const toolEvents = events.filter((e) => e.type === "tool_call");
    expect(toolEvents.map((e) => (e.type === "tool_call" ? e.name : ""))).toEqual([
      "rag_search",
      "draft_dunning",
    ]);
    expect(JSON.stringify(events)).not.toContain("F-2026-042");
  });

  it("resumes a persisted conversation under RLS", async () => {
    script = [{ content: "Première réponse." }];
    const first = await agent().run("Bonjour");
    expect(first.conversationId).toBeTruthy();

    script = [{ content: "Je me souviens du contexte." }];
    scriptIndex = 0;
    const second = await agent().run("Et maintenant ?", {
      conversationId: first.conversationId,
    });
    expect(second.conversationId).toBe(first.conversationId);
    // The resumed call carried the whole prior transcript to the model.
    const lastLoopCall = modelCalls.filter((c) => c.hasTools).at(-1);
    expect(lastLoopCall && lastLoopCall.messageCount).toBeGreaterThanOrEqual(4);

    const stored = await withTenant(tenantId, (tx) =>
      tx.agentConversation.findUnique({ where: { id: first.conversationId } }),
    );
    expect((stored?.messages as unknown[]).length).toBeGreaterThanOrEqual(5);
  });

  it("owner-only tools are filtered out of a non-owner toolset (fail-closed)", async () => {
    // Modules TOUS actifs : ce test isole le gate de rôle.
    await enableAllModules();
    try {
    for (const [role, expected] of [
      ["owner", true],
      ["member", false],
      ["accountant", false],
      [undefined, false], // no role provided = not owner
    ] as const) {
      const toolset = await buildToolset({
        tenantId,
        secretProvider: vault,
        ...(role ? { role } : {}),
      });
      const names = toolset.definitions.map((d) => d.name);
      // Paramétré sur l'ENSEMBLE OWNER_ONLY_TOOLS : tout futur ajout à la
      // liste est couvert automatiquement (audit RGPD 3.1).
      for (const tool of OWNER_ONLY_TOOLS) {
        expect(names.includes(tool)).toBe(expected);
        if (!expected) {
          await expect(toolset.execute(tool, {})).rejects.toThrow(/unknown tool/);
        }
      }
      await toolset.close();
    }
    } finally {
      await clearModuleOverrides();
    }
  });

  it("catalogue 3.11 : chaque outil référencé par un module EXISTE côté MCP (pas de dérive)", async () => {
    // Un renommage d'outil MCP non répercuté au catalogue échouerait en
    // silence côté OUVERT (module « désactivé » mais outil toujours exposé) :
    // ce test échoue sur tout nom orphelin.
    // TOUS les modules actifs : un module éteint retirerait ses outils du
    // toolset et le test ne prouverait plus rien sur eux — un renommage
    // passerait alors inaperçu précisément là où le code dort.
    await enableAllModules();
    try {
      const toolset = await buildToolset({ tenantId, secretProvider: vault, role: "owner" });
      const names = new Set(toolset.definitions.map((d) => d.name));
      for (const tool of MODULES.flatMap((module) => module.tools)) {
        expect(names.has(tool), `outil de catalogue inconnu côté MCP : ${tool}`).toBe(true);
      }
      await toolset.close();
    } finally {
      await clearModuleOverrides();
    }
  });

  it("module désactivé (3.11) : ses outils sortent du toolset, fail-open sans profil", async () => {
    // Profil avec RH et stocks désactivés : les outils rattachés disparaissent
    // même pour l'owner (absent du routage => unknown tool).
    await withTenant(tenantId, (tx) =>
      tx.tenantProfile.upsert({
        where: { tenantId },
        create: { tenantId, moduleOverrides: { rh: false, stocks: false } },
        update: { moduleOverrides: { rh: false, stocks: false } },
      }),
    );
    try {
      const toolset = await buildToolset({ tenantId, secretProvider: vault, role: "owner" });
      const names = toolset.definitions.map((d) => d.name);
      // `silae_get_*` appartient désormais au module `silae` (hors socle) :
      // l'inclure ici ferait passer le test pour une AUTRE raison que le gate
      // testé. On ne garde que les outils réellement portés par rh et stocks.
      for (const tool of ["plan_staffing", "analyze_hourly_performance", "check_stock_alerts", "adjust_stock"]) {
        expect(names.includes(tool)).toBe(false);
        await expect(toolset.execute(tool, {})).rejects.toThrow(/unknown tool/);
      }
      // Le cœur compta, qui n'est pas un module, ne bouge pas.
      expect(names).toContain("compute_treasury_forecast");
      await toolset.close();
    } finally {
      // Fail-open vérifié : sans profil, tout revient.
      await withTenant(tenantId, (tx) => tx.tenantProfile.deleteMany({}));
    }
    const restored = await buildToolset({ tenantId, secretProvider: vault, role: "owner" });
    expect(restored.definitions.map((d) => d.name)).toContain("plan_staffing");
    await restored.close();
  });

  it("traces a run to Langfuse — METADATA ONLY, never content", async () => {
    script = [
      {
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "rag_search", arguments: JSON.stringify({ query: "procédure" }) },
          },
        ],
      },
      { content: "Voilà la synthèse." },
    ];
    const tracer = createLangfuseTracer({
      baseUrl: `http://127.0.0.1:${(fakeLangfuse.address() as AddressInfo).port}`,
      publicKey: "pk-test",
      secretKey: "sk-test",
    });
    await agent(tracer).run("Question confidentielle sur nos marges");

    expect(langfuseBodies).toHaveLength(1);
    const raw = langfuseBodies[0]!;
    const batch = (JSON.parse(raw) as { batch: { body: { metadata: AgentRunTrace } }[] }).batch;
    const meta = batch[0]!.body.metadata;
    expect(meta.tenantId).toBe(tenantId);
    expect(meta.iterations).toBe(2);
    expect(meta.toolCalls).toEqual([{ name: "rag_search", ok: true }]);
    expect(meta.outcome).toBe("ok");
    expect(meta.conversationId).toBeTruthy();

    // The trace never carries the question, the RAG result or invoice data.
    expect(raw).not.toContain("marges");
    expect(raw).not.toContain("procédure");
    expect(raw).not.toContain("Procédure de relance");
    expect(raw).not.toContain("F-2026-042");
  });

  it("a conversation from another tenant is unreachable (RLS)", async () => {
    script = [{ content: "ok" }];
    const other = await admin.tenant.create({ data: { name: "Agent Other" } });
    const foreign = await admin.agentConversation.create({
      data: { tenantId: other.id, employee: "compta", messages: [] },
    });
    await expect(
      agent().run("reprends", { conversationId: foreign.id }),
    ).rejects.toThrow(/conversation not found/);
    await admin.tenant.delete({ where: { id: other.id } });

    // Same tenant but another employee's conversation: also unreachable
    // (different system prompt / perimeter must not leak into the Compta loop).
    const otherEmployee = await withTenant(tenantId, (tx) =>
      tx.agentConversation.create({ data: { tenantId, employee: "rh", messages: [] } }),
    );
    await expect(
      agent().run("reprends", { conversationId: otherEmployee.id }),
    ).rejects.toThrow(/conversation not found/);
  });
});
