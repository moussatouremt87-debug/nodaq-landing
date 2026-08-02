import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { createActionsMcpServer, TOOL_POLICIES } from "../src/server.js";

/**
 * End-to-end: MCP client -> actions server -> fake OCR service -> route()
 * (fake LiteLLM, sovereign group) -> pending_action row (real Postgres, RLS).
 * The write tool PREPARES and never executes.
 */

const INVOICE_TEXT = "FACTURE F-2026-042 ACME SARL Total TTC 1200,00 EUR";
const MODEL_ANSWER = JSON.stringify({
  supplierName: "ACME SARL",
  invoiceNumber: "F-2026-042",
  invoiceDate: "2026-07-01",
  dueDate: "2026-08-15",
  currency: "EUR",
  totalExclTax: 1000,
  totalTax: 200,
  totalInclTax: 1200,
});

let ocrShouldFail = false;
let modelAnswer = MODEL_ANSWER;
const modelCalls: { model: string }[] = [];
/** Prompts envoyés au tier souverain — sert à vérifier ce que le modèle a le
 * droit de savoir (et ce qu'on lui interdit de réclamer). */
const modelPrompts: string[] = [];

const fakeOcr = createServer((req, res) => {
  if (ocrShouldFail) {
    res.writeHead(500).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text: INVOICE_TEXT, pages: 1 }));
});

const fakeLiteLlm = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw) as {
      model: string;
      messages?: { content?: unknown }[];
    };
    modelCalls.push({ model: body.model });
    for (const message of body.messages ?? []) {
      if (typeof message.content === "string") modelPrompts.push(message.content);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: modelAnswer } }] }));
  });
});

/** Ajoute les chantiers à retenue de garantie au facturier factice (US-8). */
let retentionFixtures = false;

let admin: PrismaClient;
let tenantId: string;
const REQUESTED_BY = "11111111-2222-4333-8444-555555555555";

// Fake Qonto + Pennylane behind the connectors registry (namespaced vault refs).
const fakeSaas = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  const path = req.url ?? "";
  if (path.startsWith("/organization")) {
    res.end(
      JSON.stringify({
        organization: {
          slug: "org-t",
          bank_accounts: [
            { slug: "main", iban: "FR7616798000010000012345678", currency: "EUR", balance_cents: 100_000 },
          ],
        },
      }),
    );
  } else if (path.startsWith("/transactions")) {
    res.end(
      JSON.stringify({
        transactions: [
          { transaction_id: "t1", amount_cents: 90_000, side: "credit", settled_at: "2026-06-25T12:00:00Z" },
          { transaction_id: "t2", amount_cents: 60_000, side: "debit", settled_at: "2026-07-10T12:00:00Z" },
        ],
        meta: { current_page: 1 },
      }),
    );
  } else if (path.startsWith("/customer_invoices")) {
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
            // Forme inattendue côté fournisseur : dégradée en « non
            // attribuée » (.catch(null)), jamais un échec de page (3.4).
            customer: "ACME SARL",
          },
          // Chantiers BTP (US-8) — servis À LA DEMANDE : les ajouter au jeu
          // commun changerait les compteurs de tous les autres outils qui
          // lisent la même liste, et un test vert deviendrait un test faux.
          ...(retentionFixtures
            ? [
                // 5 % retenus jusqu'à la levée des réserves, rien d'encaissé.
                {
                  id: "inv-rg",
                  invoice_number: "F-2026-100",
                  amount: "1200.00",
                  retained_amount: "60.00",
                  residual_amount: "1140.00",
                  currency: "EUR",
                  date: "2026-05-01",
                  deadline: "2026-06-01",
                  status: "late",
                },
                // Chantier RÉGLÉ hors retenue mais resté « pending » faute de
                // lettrage (cas fréquent en PME) : il ne reste que la retenue,
                // donc rien à réclamer.
                {
                  id: "inv-rg-only",
                  invoice_number: "F-2026-101",
                  amount: "10000.00",
                  retained_amount: "500.00",
                  residual_amount: "0.00",
                  currency: "EUR",
                  date: "2026-05-01",
                  deadline: "2026-06-01",
                  status: "pending",
                },
                // Facture encaissée, sans aucune retenue : le refus doit dire
                // CE motif-là, pas parler d'une retenue qui n'existe pas.
                {
                  id: "inv-paid-unlettered",
                  invoice_number: "F-2026-102",
                  amount: "800.00",
                  residual_amount: "0.00",
                  currency: "EUR",
                  date: "2026-05-01",
                  deadline: "2026-06-01",
                  status: "pending",
                },
              ]
            : []),
        ],
        next_cursor: null,
      }),
    );
  } else {
    res.end("{}");
  }
});

const vaultEntries: Record<string, string> = {};
const vault = {
  get: (name: string) => Promise.resolve(vaultEntries[name]),
};

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeOcr.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => fakeLiteLlm.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => fakeSaas.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLlm.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test";

  admin = createAdminClient();
  await admin.pendingAction.deleteMany({ where: { tenant: { name: "Actions T" } } });
  await admin.connector.deleteMany({ where: { tenant: { name: "Actions T" } } });
  await admin.tenant.deleteMany({ where: { name: "Actions T" } });
  tenantId = (await admin.tenant.create({ data: { name: "Actions T" } })).id;

  vaultEntries[`connector/${tenantId}/qonto`] = JSON.stringify({
    organizationSlug: "org-t",
    secretKey: "sk-q",
  });
  vaultEntries[`connector/${tenantId}/pennylane`] = JSON.stringify({ apiKey: "pk-t" });
  await withTenant(tenantId, (tx) =>
    tx.connector.createMany({
      data: [
        { tenantId, type: "qonto", credentialsRef: `connector/${tenantId}/qonto` },
        { tenantId, type: "pennylane", credentialsRef: `connector/${tenantId}/pennylane` },
      ],
    }),
  );
});

afterAll(async () => {
  fakeOcr.close();
  fakeLiteLlm.close();
  fakeSaas.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

beforeEach(() => {
  ocrShouldFail = false;
  modelAnswer = MODEL_ANSWER;
  modelCalls.length = 0;
  modelPrompts.length = 0;
  retentionFixtures = false;
});

function connectedClient(extraContext: { onPendingAction?: () => void } = {}) {
  const saasBase = `http://127.0.0.1:${(fakeSaas.address() as AddressInfo).port}`;
  const server = createActionsMcpServer({
    tenantId,
    requestedBy: REQUESTED_BY,
    baseUrl: `http://127.0.0.1:${(fakeOcr.address() as AddressInfo).port}`,
    token: "test-ocr-token",
    secretProvider: vault,
    qontoBaseUrl: saasBase,
    pennylaneBaseUrl: saasBase,
    ...extraContext,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return Promise.all([server.connect(serverTransport), client.connect(clientTransport)]).then(
    () => client,
  );
}

describe("ocr_and_book_invoice — human-in-the-loop", () => {
  it("declares requiresValidation: true (TOOL_POLICIES registry) and is NOT read-only", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "ocr_and_book_invoice");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    // The MCP client strips unknown annotation keys in transit: the runtime
    // contract lives in the exported TOOL_POLICIES registry.
    const { TOOL_POLICIES } = await import("../src/server.js");
    expect(TOOL_POLICIES.ocr_and_book_invoice.requiresValidation).toBe(true);
    expect(TOOL_POLICIES.draft_dunning.requiresValidation).toBe(true);
    expect(TOOL_POLICIES.compute_treasury_forecast.requiresValidation).toBe(false);
    const dunningTool = tools.tools.find((t) => t.name === "draft_dunning");
    expect(dunningTool?.annotations?.readOnlyHint).toBe(false);
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("tenantId");
  });

  it("PREPARES a pending_action and never executes the booking", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "ocr_and_book_invoice",
      arguments: { filename: "facture.pdf", contentBase64: Buffer.from("x").toString("base64") },
    });

    const text = (result.content as { text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as { pendingActionId: string; status: string };
    expect(parsed.status).toBe("pending_validation");
    // Minimization: the confidential extracted fields do NOT come back into
    // the calling model's context — they live in the validation queue only.
    expect(text).not.toContain("ACME SARL");
    expect(text).not.toContain("1200");

    const rows = await withTenant(tenantId, (tx) =>
      tx.pendingAction.findMany({ where: { id: parsed.pendingActionId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "book_invoice",
      status: "pending",
      validatedBy: null,
      requestedBy: REQUESTED_BY,
    });
    const payload = rows[0]!.payload as { invoice: { totalInclTax: number; invoiceNumber: string } };
    expect(payload.invoice.totalInclTax).toBe(1200);
    expect(payload.invoice.invoiceNumber).toBe("F-2026-042");

    // The extraction went through route() on a SOVEREIGN group (audited).
    expect(modelCalls.every((c) => c.model !== "frontier")).toBe(true);
    const audits = await withTenant(tenantId, (tx) =>
      tx.classification.findMany({ where: { category: "confidentiel", outcome: "allowed" } }),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("OCR failure => tool error, NO pending_action created", async () => {
    ocrShouldFail = true;
    const client = await connectedClient();
    const before = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    const result = await client.callTool({
      name: "ocr_and_book_invoice",
      arguments: { filename: "f.pdf", contentBase64: Buffer.from("x").toString("base64") },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("HTTP 500");
    const after = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    expect(after).toBe(before);
  });

  it("compute_treasury_forecast is read-only and projects from Qonto data", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "compute_treasury_forecast");
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({ name: "compute_treasury_forecast", arguments: {} });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      account: string;
      currentBalanceCents: number;
      points: { horizonDays: number; projectedBalanceCents: number }[];
    };
    expect(parsed.account).toBe("main");
    expect(parsed.currentBalanceCents).toBe(100_000);
    expect(parsed.points.map((p) => p.horizonDays)).toEqual([30, 60, 90]);
    // No pending_action for a read tool.
  });

  it("draft_dunning PREPARES a send_dunning pending_action with the sovereign draft", async () => {
    modelAnswer = "Bonjour,\n\nSauf erreur de notre part, la facture F-2026-042 reste impayée...";
    const client = await connectedClient();
    const result = await client.callTool({
      name: "draft_dunning",
      arguments: { invoiceId: "inv-42" },
    });

    const text = (result.content as { text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as { pendingActionId: string; status: string; riskBand: string };
    expect(parsed.status).toBe("pending_validation");
    expect(["medium", "high"]).toContain(parsed.riskBand);
    // Minimization: the draft (confidentiel) does NOT come back in the context.
    expect(text).not.toContain("Sauf erreur de notre part");

    const rows = await withTenant(tenantId, (tx) =>
      tx.pendingAction.findMany({ where: { id: parsed.pendingActionId } }),
    );
    expect(rows[0]).toMatchObject({ type: "send_dunning", status: "pending", validatedBy: null });
    const payload = rows[0]!.payload as {
      invoice: { number: string; amountCents: number };
      risk: { band: string };
      draft: string;
    };
    expect(payload.invoice).toMatchObject({ number: "F-2026-042", amountCents: 120_000 });
    expect(payload.draft).toContain("Sauf erreur de notre part");
    expect(modelCalls.every((c) => c.model !== "frontier")).toBe(true);
  });

  it("BLOQUANT (US-8) : la relance ne réclame QUE l'exigible, jamais la retenue", async () => {
    // Chantier de 1 200 € dont 60 € (5 %) retenus jusqu'à la levée des
    // réserves. Réclamer 1 200 €, c'est réclamer une somme que le client a le
    // droit de garder — la faute qui décrédibilise l'outil devant un artisan.
    modelAnswer = "Bonjour, sauf erreur la facture F-2026-100 reste impayée...";
    retentionFixtures = true;
    const client = await connectedClient();
    const result = await client.callTool({
      name: "draft_dunning",
      arguments: { invoiceId: "inv-rg" },
    });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      pendingActionId: string;
    };
    const rows = await withTenant(tenantId, (tx) =>
      tx.pendingAction.findMany({ where: { id: parsed.pendingActionId } }),
    );
    const payload = rows[0]!.payload as {
      invoice: { amountCents: number; totalCents: number; retainedCents: number };
    };
    // Réclamé : 1 140 €. Facturé : 1 200 €. Retenu : 60 €. Les trois sont
    // dits — un écart muet passerait pour une erreur de calcul.
    expect(payload.invoice.amountCents).toBe(114_000);
    expect(payload.invoice.totalCents).toBe(120_000);
    expect(payload.invoice.retainedCents).toBe(6_000);
    // Le modèle rédige à partir de l'exigible et sait que la retenue est hors
    // relance : rien à inventer, rien à additionner.
    const prompt = modelPrompts.join("\n");
    expect(prompt).toContain("montant exigible 1140");
    expect(prompt).toContain("n'est PAS réclamée");
  });

  it("BLOQUANT (US-8) : chantier réglé hors retenue => refus MOTIVÉ, aucune relance", async () => {
    // Le vrai cas du terrain : 10 000 € facturés, 9 500 € encaissés, lignes
    // NON lettrées — le facturier laisse la facture « pending ». Sans le
    // solde restant dû, la relance repartait du montant facturé et réclamait
    // 9 500 € déjà perçus. Un montant nul silencieux, lui, ferait naître une
    // relance à 0 € dans la file — que l'humain validerait sans comprendre.
    retentionFixtures = true;
    const client = await connectedClient();
    const before = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    const result = await client.callTool({
      name: "draft_dunning",
      arguments: { invoiceId: "inv-rg-only" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("retainage");
    const after = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    expect(after).toBe(before);
  });

  it("le refus dit le VRAI motif : sans retenue, on ne parle pas de retenue", async () => {
    retentionFixtures = true;
    const client = await connectedClient();
    const result = await client.callTool({
      name: "draft_dunning",
      arguments: { invoiceId: "inv-paid-unlettered" },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("no outstanding balance");
    expect(text).not.toContain("retainage");
  });

  it("draft_dunning on an unknown invoice => error, no pending_action", async () => {
    const client = await connectedClient();
    const before = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    const result = await client.callTool({
      name: "draft_dunning",
      arguments: { invoiceId: "nope" },
    });
    expect(result.isError).toBe(true);
    const after = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    expect(after).toBe(before);
  });

  it("non-JSON model output => tool error WITHOUT echoing model output, no pending_action", async () => {
    modelAnswer = "je ne peux pas, mais voici l'IBAN FR7612345 de la facture";
    const client = await connectedClient();
    const before = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    const result = await client.callTool({
      name: "ocr_and_book_invoice",
      arguments: { filename: "f.pdf", contentBase64: Buffer.from("x").toString("base64") },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("FR7612345");
    const after = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    expect(after).toBe(before);
  });
});

describe("stocks (ticket 3.2) — lecture libre, ajustement HITL", () => {
  it("check_stock_alerts liste les articles sous seuil ; adjust_stock PRÉPARE sans jamais exécuter", async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.stockMovement.deleteMany({});
      await tx.stockItem.deleteMany({});
      await tx.stockItem.createMany({
        data: [
          { tenantId, name: "Disjoncteur 20A", unit: "unité", quantity: 3, alertThreshold: 10 },
          { tenantId, name: "Gaine ICTA", unit: "mètre", quantity: 500, alertThreshold: 100 },
        ],
      });
    });

    const client = await connectedClient();
    const alerts = JSON.parse(
      (
        (await client.callTool({ name: "check_stock_alerts", arguments: {} })).content as {
          text: string;
        }[]
      )[0]!.text,
    ) as { alerts: { name: string }[]; alertCount: number; totalItems: number };
    expect(alerts.alertCount).toBe(1);
    expect(alerts.totalItems).toBe(2);
    expect(alerts.alerts[0]?.name).toBe("Disjoncteur 20A");

    expect(TOOL_POLICIES.adjust_stock.requiresValidation).toBe(true);
    const result = await client.callTool({
      name: "adjust_stock",
      arguments: { itemName: "Disjoncteur 20A", delta: 20, reason: "réassort" },
    });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      pendingActionId: string;
      status: string;
    };
    expect(parsed.status).toBe("pending_validation");

    // RIEN n'a bougé : la quantité ne change qu'à l'approbation humaine.
    const item = await withTenant(tenantId, (tx) =>
      tx.stockItem.findUnique({ where: { tenantId_name: { tenantId, name: "Disjoncteur 20A" } } }),
    );
    expect(item?.quantity).toBe(3);
    const action = await withTenant(tenantId, (tx) =>
      tx.pendingAction.findUnique({ where: { id: parsed.pendingActionId } }),
    );
    expect(action).toMatchObject({ type: "adjust_stock", status: "pending" });
    expect(action?.payload).toMatchObject({ delta: 20, quantityBefore: 3 });

    // Article inconnu : erreur outil, aucune pending_action créée.
    const before = await withTenant(tenantId, (tx) => tx.pendingAction.count());
    const unknown = await client.callTool({
      name: "adjust_stock",
      arguments: { itemName: "N'existe pas", delta: 1 },
    });
    expect(unknown.isError).toBe(true);
    expect(await withTenant(tenantId, (tx) => tx.pendingAction.count())).toBe(before);
  });
});

describe("sonnette push (2.17)", () => {
  it("préparer une pending_action sonne onPendingAction — un signal, zéro donnée", async () => {
    let rings = 0;
    const client = await connectedClient({ onPendingAction: () => void (rings += 1) });
    const result = await client.callTool({
      name: "adjust_stock",
      arguments: { itemName: "Disjoncteur 20A", delta: 1, reason: "test sonnette" },
    });
    expect(result.isError).toBeFalsy();
    expect(rings).toBe(1);
  });
});

describe("analyze_hourly_performance — performance horaire (3.6)", () => {
  it("lecture seule, CA observé ÷ heures contractuelles, labellisé estimation", async () => {
    const created = await withTenant(tenantId, (tx) =>
      tx.staffMember.create({
        data: { tenantId, name: "Karim T", role: "technicien", weeklyHours: 35 },
      }),
    );
    try {
      const client = await connectedClient();
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === "analyze_hourly_performance");
      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(JSON.stringify(tool?.inputSchema)).not.toContain("tenantId");
      expect(TOOL_POLICIES.analyze_hourly_performance.requiresValidation).toBe(false);

      const result = await client.callTool({
        name: "analyze_hourly_performance",
        arguments: { monthsBack: 12 },
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
        months: { month: string; workedHours: number; revenuePerHourCents: number | null }[];
        activeStaff: number;
        label: string;
        revenueUnavailable: boolean;
        staffTruncated: boolean;
        revenueTruncated: boolean;
        truncated: boolean;
      };
      // La facture du faux SaaS (1 200 € en 2026-05) ouvre la fenêtre observée ;
      // 35 h hebdo x 4,348 = 152 h estimées par mois.
      expect(parsed.activeStaff).toBe(1);
      expect(parsed.revenueUnavailable).toBe(false);
      expect(parsed.staffTruncated).toBe(false);
      expect(parsed.revenueTruncated).toBe(false);
      expect(parsed.truncated).toBe(false);
      const may = parsed.months.find((m) => m.month === "2026-05");
      expect(may).toMatchObject({
        workedHours: 152,
        revenuePerHourCents: Math.round(120_000 / 152),
      });
      expect(parsed.label).toContain("estimation");
      // Le nom du salarié (PII) ne sort JAMAIS de l'outil.
      expect(JSON.stringify(parsed)).not.toContain("Karim");
    } finally {
      await withTenant(tenantId, (tx) => tx.staffMember.delete({ where: { id: created.id } }));
    }
  });
});

describe("avis clients — analyze_reputation & draft_review_reply (3.8)", () => {
  it("synthèse en agrégats (jamais un nom), brouillon HITL sans PII vers le modèle", async () => {
    const review = await withTenant(tenantId, (tx) =>
      tx.customerReview.create({
        data: {
          tenantId,
          rating: 1,
          authorName: "Paul Martin",
          text: "Chantier livré en retard.",
          reviewedAt: new Date(Date.now() - 3 * 86_400_000),
        },
        select: { id: true },
      }),
    );
    try {
      const client = await connectedClient();
      const tools = await client.listTools();
      expect(tools.tools.find((t) => t.name === "analyze_reputation")?.annotations?.readOnlyHint).toBe(true);
      expect(TOOL_POLICIES.analyze_reputation.requiresValidation).toBe(false);
      expect(TOOL_POLICIES.draft_review_reply.requiresValidation).toBe(true);

      const summary = await client.callTool({ name: "analyze_reputation", arguments: {} });
      const report = JSON.parse((summary.content as { text: string }[])[0]!.text) as {
        totalReviews: number;
        unansweredNegative: { id: string }[];
      };
      expect(report.totalReviews).toBe(1);
      expect(report.unansweredNegative[0]?.id).toBe(review.id);
      // Agrégats seulement : ni nom d'auteur ni texte d'avis dans la sortie.
      expect(JSON.stringify(report)).not.toContain("Paul");
      expect(JSON.stringify(report)).not.toContain("retard");

      const drafted = await client.callTool({
        name: "draft_review_reply",
        arguments: { reviewId: review.id },
      });
      expect(drafted.isError).toBeFalsy();
      const result = JSON.parse((drafted.content as { text: string }[])[0]!.text) as {
        pendingActionId: string;
        status: string;
      };
      expect(result.status).toBe("pending_validation");
      const action = await withTenant(tenantId, (tx) =>
        tx.pendingAction.findUnique({ where: { id: result.pendingActionId } }),
      );
      expect(action?.type).toBe("record_review_reply");
      const payload = action?.payload as { review: { id: string }; draft: string };
      expect(payload.review.id).toBe(review.id);
      expect(payload.draft.length).toBeGreaterThan(0);
      // Minimisation : le nom de l'auteur ne va NI au modèle NI dans la file.
      expect(JSON.stringify(payload)).not.toContain("Paul");
      // Le prompt envoyé au faux LiteLLM ne contient pas le nom non plus —
      // garanti par construction (seuls note + texte sont transmis).

      // Avis déjà répondu : refus net, jamais un second brouillon en file.
      await withTenant(tenantId, (tx) =>
        tx.customerReview.update({
          where: { id: review.id },
          data: { replyText: "Réponse validée", repliedAt: new Date() },
        }),
      );
      const replayed = await client.callTool({
        name: "draft_review_reply",
        arguments: { reviewId: review.id },
      });
      expect(replayed.isError).toBe(true);
    } finally {
      await withTenant(tenantId, async (tx) => {
        await tx.pendingAction.deleteMany({ where: { type: "record_review_reply" } });
        await tx.customerReview.delete({ where: { id: review.id } });
      });
    }
  });
});

describe("check_rgpd_register — assistant RGPD (3.9)", () => {
  it("lecture seule, registre vide = alerte art. 30, label permanent", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "check_rgpd_register");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tool?.inputSchema ?? {})).not.toContain("tenantId");
    expect(TOOL_POLICIES.check_rgpd_register.requiresValidation).toBe(false);

    const result = await client.callTool({ name: "check_rgpd_register", arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      version: string;
      activityCount: number;
      issues: { code: string; severity: string }[];
      label: string;
      truncated: boolean;
    };
    expect(parsed.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.activityCount).toBe(0);
    expect(parsed.issues.some((i) => i.code === "registre_vide" && i.severity === "alerte")).toBe(true);
    expect(parsed.label).toContain("DPO");
    expect(parsed.truncated).toBe(false);
  });
});

describe("check_regulatory_watch — veille réglementaire (3.7)", () => {
  it("lecture seule, profil honnête (effectif inconnu jamais lu comme 0), label permanent", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "check_regulatory_watch");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tool?.inputSchema ?? {})).not.toContain("tenantId");
    expect(TOOL_POLICIES.check_regulatory_watch.requiresValidation).toBe(false);

    const result = await client.callTool({ name: "check_regulatory_watch", arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      version: string;
      label: string;
      profile: { vertical: string; headcount: number | null; headcountSource: string };
      matches: { id: string; applies: string }[];
    };
    // Tenant sans profil ni équipe : vertical « autre », effectif inconnu —
    // les obligations à seuil restent visibles « peut_etre », jamais tues.
    expect(parsed.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.label).toContain("conseil juridique");
    expect(parsed.profile).toMatchObject({ vertical: "autre", headcount: null, headcountSource: "inconnu" });
    const cse = parsed.matches.find((m) => m.id === "cse");
    expect(cse?.applies).toBe("peut_etre");
  });
});

describe("analyze_customer_signals — signaux clients (3.4)", () => {
  it("lecture seule, tenant non injectable, comptes exacts et bornage signalé", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "analyze_customer_signals");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("tenantId");
    expect(TOOL_POLICIES.analyze_customer_signals.requiresValidation).toBe(false);

    const result = await client.callTool({ name: "analyze_customer_signals", arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      customers: unknown[];
      totalCustomers: number;
      customersTruncated: boolean;
      analyzedInvoices: number;
      unattributedInvoices: number;
      truncated: boolean;
    };
    // La facture du faux SaaS porte un `customer` MALFORMÉ (chaîne) : la page
    // se parse quand même (.catch(null)) et la vente est comptée « non
    // attribuée » — jamais écartée en silence, jamais un échec d'outil.
    expect(parsed).toMatchObject({
      customers: [],
      totalCustomers: 0,
      customersTruncated: false,
      analyzedInvoices: 1,
      unattributedInvoices: 1,
      truncated: false,
    });
  });
});
