import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { createActionsMcpServer } from "../src/server.js";

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
    const body = JSON.parse(raw) as { model: string };
    modelCalls.push({ model: body.model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: modelAnswer } }] }));
  });
});

let admin: PrismaClient;
let tenantId: string;
const REQUESTED_BY = "11111111-2222-4333-8444-555555555555";

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeOcr.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => fakeLiteLlm.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLlm.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test";

  admin = createAdminClient();
  await admin.pendingAction.deleteMany({ where: { tenant: { name: "Actions T" } } });
  await admin.tenant.deleteMany({ where: { name: "Actions T" } });
  tenantId = (await admin.tenant.create({ data: { name: "Actions T" } })).id;
});

afterAll(async () => {
  fakeOcr.close();
  fakeLiteLlm.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

beforeEach(() => {
  ocrShouldFail = false;
  modelAnswer = MODEL_ANSWER;
  modelCalls.length = 0;
});

function connectedClient() {
  const server = createActionsMcpServer({
    tenantId,
    requestedBy: REQUESTED_BY,
    baseUrl: `http://127.0.0.1:${(fakeOcr.address() as AddressInfo).port}`,
    token: "test-ocr-token",
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
