import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PennylaneClient } from "../src/pennylane.js";
import { QontoClient } from "../src/qonto.js";

/** Fake SaaS APIs: record requests, serve canned fixtures. No real API is hit. */

interface Recorded {
  path: string;
  authorization: string | undefined;
}

const recorded: Recorded[] = [];
let failuresLeft = 0;

const fake = createServer((req, res) => {
  recorded.push({ path: req.url ?? "", authorization: req.headers.authorization });
  if (failuresLeft > 0) {
    failuresLeft--;
    res.writeHead(503).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  const path = req.url ?? "";
  if (path.startsWith("/customer_invoices")) {
    res.end(
      JSON.stringify({
        items: [
          {
            id: 42,
            invoice_number: "F-2026-001",
            amount: "1200.00",
            currency: "EUR",
            date: "2026-07-01",
            status: "late",
            // Extra fields MUST be stripped by the client (data minimization):
            customer_snapshot: { email: "pii@exemple.fr", phone: "0612345678" },
          },
        ],
        next_cursor: null,
      }),
    );
  } else if (path.startsWith("/customers")) {
    res.end(JSON.stringify({ items: [{ id: "c1", name: "ACME SARL" }] }));
  } else if (path.startsWith("/organization")) {
    res.end(
      JSON.stringify({
        organization: {
          slug: "acme-org",
          bank_accounts: [
            { slug: "main", iban: "FR7616798000010000012345678", currency: "EUR", balance_cents: 152000 },
          ],
        },
      }),
    );
  } else if (path.startsWith("/transactions")) {
    res.end(
      JSON.stringify({
        transactions: [
          {
            transaction_id: "tx-1",
            amount_cents: -4500,
            currency: "EUR",
            side: "debit",
            settled_at: "2026-07-20T10:00:00Z",
            label: "AWS EMEA",
            internal_note: "should be stripped",
          },
        ],
        meta: { current_page: 1, total_pages: 1 },
      }),
    );
  } else {
    res.end("{}");
  }
});

let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(() => {
  fake.close();
});

beforeEach(() => {
  recorded.length = 0;
  failuresLeft = 0;
});

describe("PennylaneClient", () => {
  const client = () => new PennylaneClient({ apiKey: "pk-test-123" }, baseUrl);

  it("sends the Bearer key and parses invoices, stripping unknown fields", async () => {
    const result = await client().listCustomerInvoices({ limit: 10 });
    expect(recorded[0]).toMatchObject({ authorization: "Bearer pk-test-123" });
    expect(recorded[0]?.path).toContain("limit=10");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "42", invoice_number: "F-2026-001" });
    // Data minimization: nested PII from the raw payload never crosses.
    expect(JSON.stringify(result)).not.toContain("pii@exemple.fr");
  });

  it("lists customers", async () => {
    const result = await client().listCustomers();
    expect(result.items[0]).toMatchObject({ id: "c1", name: "ACME SARL" });
  });

  it("retries once on 5xx then succeeds", async () => {
    failuresLeft = 1;
    const result = await client().listCustomerInvoices();
    expect(result.items).toHaveLength(1);
    expect(recorded).toHaveLength(2);
  });

  it("gives up after retries with a status-only error (no body leakage)", async () => {
    failuresLeft = 5;
    await expect(client().listCustomerInvoices()).rejects.toThrow(/HTTP 503 on \/customer_invoices/);
  });
});

describe("QontoClient", () => {
  const client = () =>
    new QontoClient({ organizationSlug: "acme-org", secretKey: "sk-qonto-test" }, baseUrl);

  it("sends slug:secretKey auth and parses the organization", async () => {
    const result = await client().getOrganization();
    expect(recorded[0]).toMatchObject({ authorization: "acme-org:sk-qonto-test" });
    expect(result.organization.bank_accounts[0]).toMatchObject({
      slug: "main",
      balance_cents: 152000,
    });
  });

  it("parses transactions with pagination params, stripping unknown fields", async () => {
    const result = await client().listTransactions({ iban: "FR76...", page: 2, perPage: 50 });
    expect(recorded[0]?.path).toContain("current_page=2");
    expect(recorded[0]?.path).toContain("per_page=50");
    expect(result.transactions[0]).toMatchObject({ transaction_id: "tx-1", amount_cents: -4500 });
    expect(JSON.stringify(result)).not.toContain("internal_note");
  });
});
