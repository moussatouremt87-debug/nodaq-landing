import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import type { SecretProvider } from "@nodaq/secrets";
import {
  ConnectorNotConfiguredError,
  DEMO_CONNECTOR_STATUS,
  connectorSecretName,
  getBankClient,
  getPennylaneClient,
  getQontoClient,
  getSilaeClient,
} from "../src/registry.js";
import { BridgeClient } from "../src/bridge.js";
import { DemoQontoClient } from "../src/demo.js";
import { createConnectorsMcpServer } from "../src/server.js";

/**
 * End-to-end: MCP client -> MCP server (in-memory transport) -> registry
 * (real Postgres, RLS) -> vault (recording fake) -> fake SaaS API.
 */

const FULL_IBAN = "FR7616798000010000012345678";

const recordedSaas: string[] = [];
let bigEmployeesPage = false;
const fakeSaas = createServer((req, res) => {
  recordedSaas.push(req.url ?? "");
  res.writeHead(200, { "content-type": "application/json" });
  const path = req.url ?? "";
  if (path.startsWith("/customer_invoices")) {
    res.end(
      JSON.stringify({ items: [{ id: 1, invoice_number: "F-1", status: "paid" }], next_cursor: null }),
    );
  } else if (path.startsWith("/organization")) {
    res.end(
      JSON.stringify({
        organization: {
          slug: "org-a",
          bank_accounts: [{ slug: "main", iban: FULL_IBAN, currency: "EUR", balance_cents: 99 }],
        },
      }),
    );
  } else if (path.startsWith("/transactions")) {
    res.end(
      JSON.stringify({
        transactions: [{ transaction_id: "tx-1", amount_cents: -100, side: "debit" }],
        meta: { current_page: 1 },
      }),
    );
  } else if (path.startsWith("/employees")) {
    if (bigEmployeesPage) {
      // Un seul aller-retour renvoie déjà PLUS que la borne (501) : suffit à
      // exercer `truncated` sans devoir simuler des centaines de pages.
      res.end(
        JSON.stringify({
          items: Array.from({ length: 501 }, (_, i) => ({ id: `emp-${i}` })),
          next_cursor: null,
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        items: [
          { id: "emp-1", first_name: "Karim", last_name: "Haddad", weekly_hours: 35, active: true },
        ],
        next_cursor: null,
      }),
    );
  } else if (path.startsWith("/absences")) {
    res.end(
      JSON.stringify({
        items: [
          {
            id: "abs-1",
            employee_id: "emp-1",
            type: "maladie",
            start_date: "2026-07-10",
            end_date: "2026-07-11",
          },
        ],
        next_cursor: null,
      }),
    );
  } else {
    res.end("{}");
  }
});

let admin: PrismaClient;
let baseUrl: string;
let tenantA: string;
let tenantB: string;

/** Recording fake vault: tracks reads to prove namespace violations never reach it. */
const vaultEntries: Record<string, string> = {};
const vaultReads: string[] = [];
const vault: SecretProvider = {
  get(name) {
    vaultReads.push(name);
    return Promise.resolve(vaultEntries[name]);
  },
};

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeSaas.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(fakeSaas.address() as AddressInfo).port}`;

  admin = createAdminClient();
  // Test hygiene: scope cleanup to THIS suite's tenants (shared Postgres).
  await admin.connector.deleteMany({ where: { tenant: { name: { in: ["Conn A", "Conn B"] } } } });
  await admin.tenant.deleteMany({ where: { name: { in: ["Conn A", "Conn B"] } } });
  tenantA = (await admin.tenant.create({ data: { name: "Conn A" } })).id;
  tenantB = (await admin.tenant.create({ data: { name: "Conn B" } })).id;

  vaultEntries[connectorSecretName(tenantA, "pennylane")] = JSON.stringify({
    apiKey: "pk-tenant-a",
  });
  vaultEntries[connectorSecretName(tenantA, "qonto")] = JSON.stringify({
    organizationSlug: "org-a",
    secretKey: "sk-a",
  });
  vaultEntries[connectorSecretName(tenantA, "silae")] = JSON.stringify({
    apiKey: "silae-api-key-1234",
    dossierId: "dossier-a",
  });

  await withTenant(tenantA, (tx) =>
    tx.connector.createMany({
      data: [
        {
          tenantId: tenantA,
          type: "pennylane",
          credentialsRef: connectorSecretName(tenantA, "pennylane"),
        },
        { tenantId: tenantA, type: "qonto", credentialsRef: connectorSecretName(tenantA, "qonto") },
        { tenantId: tenantA, type: "silae", credentialsRef: connectorSecretName(tenantA, "silae") },
      ],
    }),
  );
});

afterAll(async () => {
  fakeSaas.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

function connectedClient() {
  const server = createConnectorsMcpServer({
    tenantId: tenantA,
    secretProvider: vault,
    pennylaneBaseUrl: baseUrl,
    qontoBaseUrl: baseUrl,
    silaeBaseUrl: baseUrl,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return Promise.all([server.connect(serverTransport), client.connect(clientTransport)]).then(
    () => client,
  );
}

function textOf(result: { content?: unknown }): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

describe("MCP server (per-tenant, read-only)", () => {
  it("exposes the 6 read-only tools", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "pennylane_get_customers",
      "pennylane_get_invoices",
      "qonto_get_bank_transactions",
      "qonto_get_organization",
      "silae_get_absences",
      "silae_get_employees",
    ]);
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("silae_get_employees goes through registry + vault + fake API", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "silae_get_employees", arguments: {} });
    const parsed = JSON.parse(textOf(result)) as {
      employees: { id: string; name: string | null; weeklyHours: number | null; active: boolean | null }[];
      truncated: boolean;
    };
    expect(parsed.employees).toEqual([
      { id: "emp-1", name: "Karim Haddad", weeklyHours: 35, active: true },
    ]);
    expect(parsed.truncated).toBe(false);
  });

  it("silae_get_absences validates from/to (YYYY-MM-DD) and returns the mapped shape", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "silae_get_absences",
      arguments: { from: "2026-07-01", to: "2026-07-31" },
    });
    const parsed = JSON.parse(textOf(result)) as {
      absences: { id: string; employeeId: string; type: string | null; startDate: string; endDate: string }[];
      truncated: boolean;
    };
    expect(parsed.absences).toEqual([
      {
        id: "abs-1",
        employeeId: "emp-1",
        type: "maladie",
        startDate: "2026-07-10",
        endDate: "2026-07-11",
      },
    ]);
    expect(parsed.truncated).toBe(false);

    const rejected = await client
      .callTool({ name: "silae_get_absences", arguments: { from: "30-07-2026" } })
      .then(
        (r) => r,
        (e: Error) => e,
      );
    const isError = rejected instanceof Error || (rejected as { isError?: boolean }).isError === true;
    expect(isError).toBe(true);
  });

  it("silae_get_employees signals `truncated` when the bound (500) is exceeded", async () => {
    bigEmployeesPage = true;
    try {
      const client = await connectedClient();
      const result = await client.callTool({ name: "silae_get_employees", arguments: {} });
      const parsed = JSON.parse(textOf(result)) as { employees: unknown[]; truncated: boolean };
      expect(parsed.employees).toHaveLength(500);
      expect(parsed.truncated).toBe(true);
    } finally {
      bigEmployeesPage = false;
    }
  });

  it("pennylane_get_invoices goes through registry + vault + fake API", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "pennylane_get_invoices",
      arguments: { limit: 5 },
    });
    const parsed = JSON.parse(textOf(result)) as { items: { invoice_number: string }[] };
    expect(parsed.items[0]?.invoice_number).toBe("F-1");
  });

  it("qonto_get_organization masks the IBAN (data minimization)", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "qonto_get_organization", arguments: {} });
    const text = textOf(result);
    const parsed = JSON.parse(text) as {
      organization: { bank_accounts: { iban: string; balance_cents: number }[] };
    };
    expect(parsed.organization.bank_accounts[0]).toMatchObject({
      iban: "****5678",
      balance_cents: 99,
    });
    expect(text).not.toContain(FULL_IBAN);
  });

  it("qonto_get_bank_transactions works by account SLUG, full IBAN stays server-side", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "qonto_get_bank_transactions",
      arguments: { accountSlug: "main", perPage: 10 },
    });
    const text = textOf(result);
    expect(JSON.parse(text).transactions[0].transaction_id).toBe("tx-1");
    expect(text).not.toContain(FULL_IBAN);
    // The Qonto API DID receive the full IBAN (resolved in memory from the slug).
    expect(recordedSaas.some((p) => p.includes(encodeURIComponent(FULL_IBAN)))).toBe(true);
  });

  it("the tenant is bound at construction: tool input cannot select a tenant", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("tenantId");
    }
  });
});

describe("registry — tenant isolation & failure modes", () => {
  it("a tenant without a connector gets ConnectorNotConfiguredError (RLS-scoped read)", async () => {
    await expect(
      getPennylaneClient(tenantB, { secretProvider: vault, pennylaneBaseUrl: baseUrl }),
    ).rejects.toThrow(ConnectorNotConfiguredError);
  });

  it("silae : tenant A resolves through vault + fake API, tenant B (unconfigured) is refused", async () => {
    const silae = await getSilaeClient(tenantA, { secretProvider: vault, silaeBaseUrl: baseUrl });
    const { items } = await silae.listEmployees();
    expect(items[0]).toMatchObject({ id: "emp-1", first_name: "Karim" });

    await expect(
      getSilaeClient(tenantB, { secretProvider: vault, silaeBaseUrl: baseUrl }),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
  });

  it("a credentials ref OUTSIDE the tenant namespace is refused BEFORE any vault read", async () => {
    await withTenant(tenantB, (tx) =>
      tx.connector.create({
        data: {
          tenantId: tenantB,
          type: "pennylane",
          // Poisoned pointer: another tenant's secret (or any arbitrary name).
          credentialsRef: connectorSecretName(tenantA, "pennylane"),
        },
      }),
    );
    vaultReads.length = 0;
    await expect(
      getPennylaneClient(tenantB, { secretProvider: vault, pennylaneBaseUrl: baseUrl }),
    ).rejects.toThrow(ConnectorNotConfiguredError);
    expect(vaultReads).toHaveLength(0);
  });

  it("a disabled connector is refused with a GENERIC message (no ref, no tenant)", async () => {
    await withTenant(tenantA, (tx) =>
      tx.connector.update({
        where: { tenantId_type: { tenantId: tenantA, type: "pennylane" } },
        data: { status: "disabled" },
      }),
    );
    try {
      const error = await getPennylaneClient(tenantA, {
        secretProvider: vault,
        pennylaneBaseUrl: baseUrl,
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(ConnectorNotConfiguredError);
      expect(error?.message).toBe('connector "pennylane" unavailable');
      expect(error?.message).not.toContain(tenantA);
    } finally {
      await withTenant(tenantA, (tx) =>
        tx.connector.update({
          where: { tenantId_type: { tenantId: tenantA, type: "pennylane" } },
          data: { status: "active" },
        }),
      );
    }
  });

  it("a missing vault secret is refused with the same generic message", async () => {
    await withTenant(tenantA, (tx) =>
      tx.connector.update({
        where: { tenantId_type: { tenantId: tenantA, type: "qonto" } },
        data: { credentialsRef: connectorSecretName(tenantA, "qonto-missing") },
      }),
    );
    try {
      const error = await getQontoClient(tenantA, {
        secretProvider: vault,
        qontoBaseUrl: baseUrl,
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(ConnectorNotConfiguredError);
      expect(error?.message).toBe('connector "qonto" unavailable');
      expect(error?.message).not.toContain("qonto-missing");
    } finally {
      await withTenant(tenantA, (tx) =>
        tx.connector.update({
          where: { tenantId_type: { tenantId: tenantA, type: "qonto" } },
          data: { credentialsRef: connectorSecretName(tenantA, "qonto") },
        }),
      );
    }
  });
});

describe("getBankClient — Qonto priority, Bridge fallback (ticket 2.15)", () => {
  let admin: PrismaClient;
  let tenantQontoOnly: string;
  let tenantBridgeOnly: string;
  let tenantBoth: string;
  let tenantNeither: string;
  let tenantBridgeDemo: string;

  const bankVaultEntries: Record<string, string> = {};
  const bankVault: SecretProvider = {
    get(name) {
      return Promise.resolve(bankVaultEntries[name]);
    },
  };

  beforeAll(async () => {
    admin = createAdminClient();
    const names = [
      "Bank Qonto Only",
      "Bank Bridge Only",
      "Bank Both",
      "Bank Neither",
      "Bank Bridge Demo",
    ];
    await admin.connector.deleteMany({ where: { tenant: { name: { in: names } } } });
    await admin.tenant.deleteMany({ where: { name: { in: names } } });
    tenantQontoOnly = (await admin.tenant.create({ data: { name: "Bank Qonto Only" } })).id;
    tenantBridgeOnly = (await admin.tenant.create({ data: { name: "Bank Bridge Only" } })).id;
    tenantBoth = (await admin.tenant.create({ data: { name: "Bank Both" } })).id;
    tenantNeither = (await admin.tenant.create({ data: { name: "Bank Neither" } })).id;
    tenantBridgeDemo = (await admin.tenant.create({ data: { name: "Bank Bridge Demo" } })).id;

    bankVaultEntries[connectorSecretName(tenantQontoOnly, "qonto")] = JSON.stringify({
      organizationSlug: "qonto-only-org",
      secretKey: "sk-qonto-only",
    });
    bankVaultEntries[connectorSecretName(tenantBridgeOnly, "bridge")] = JSON.stringify({
      clientId: "bridge-client-id",
      clientSecret: "bridge-client-secret",
      userUuid: "bridge-user-only",
    });
    bankVaultEntries[connectorSecretName(tenantBoth, "qonto")] = JSON.stringify({
      organizationSlug: "both-org",
      secretKey: "sk-both",
    });
    bankVaultEntries[connectorSecretName(tenantBoth, "bridge")] = JSON.stringify({
      clientId: "should-never-be-read",
      clientSecret: "should-never-be-read",
      userUuid: "should-never-be-read",
    });

    await withTenant(tenantQontoOnly, (tx) =>
      tx.connector.create({
        data: {
          tenantId: tenantQontoOnly,
          type: "qonto",
          credentialsRef: connectorSecretName(tenantQontoOnly, "qonto"),
        },
      }),
    );
    await withTenant(tenantBridgeOnly, (tx) =>
      tx.connector.create({
        data: {
          tenantId: tenantBridgeOnly,
          type: "bridge",
          credentialsRef: connectorSecretName(tenantBridgeOnly, "bridge"),
        },
      }),
    );
    await withTenant(tenantBoth, (tx) =>
      tx.connector.createMany({
        data: [
          { tenantId: tenantBoth, type: "qonto", credentialsRef: connectorSecretName(tenantBoth, "qonto") },
          { tenantId: tenantBoth, type: "bridge", credentialsRef: connectorSecretName(tenantBoth, "bridge") },
        ],
      }),
    );
    await withTenant(tenantBridgeDemo, (tx) =>
      tx.connector.create({
        data: {
          tenantId: tenantBridgeDemo,
          type: "bridge",
          status: DEMO_CONNECTOR_STATUS,
          credentialsRef: connectorSecretName(tenantBridgeDemo, "bridge"),
        },
      }),
    );
  });

  afterAll(async () => {
    await admin.$disconnect();
  });

  it("row qonto -> QontoClient (priority over Bridge)", async () => {
    const client = await getBankClient(tenantQontoOnly, {
      secretProvider: bankVault,
      qontoBaseUrl: baseUrl,
    });
    const { organization } = await client.getOrganization();
    expect(organization.slug).toBe("org-a"); // fixed slug from the fake SaaS server fixture
  });

  it("qonto + bridge both configured -> qonto wins, bridge vault never read", async () => {
    const client = await getBankClient(tenantBoth, {
      secretProvider: bankVault,
      qontoBaseUrl: baseUrl,
    });
    const { organization } = await client.getOrganization();
    expect(organization.slug).toBe("org-a");
  });

  it("no qonto, row bridge -> BridgeClient", async () => {
    const client = await getBankClient(tenantBridgeOnly, { secretProvider: bankVault });
    expect(client).toBeInstanceOf(BridgeClient);
    expect(client).not.toBeInstanceOf(DemoQontoClient);
  });

  it("neither qonto nor bridge configured -> ConnectorNotConfiguredError", async () => {
    await expect(
      getBankClient(tenantNeither, { secretProvider: bankVault }),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
  });

  it("row bridge in status demo -> DemoQontoClient (demo fixtures, no vault read)", async () => {
    const explodingVault: SecretProvider = {
      get() {
        throw new Error("vault must never be read in demo mode");
      },
    };
    const client = await getBankClient(tenantBridgeDemo, { secretProvider: explodingVault });
    expect(client).toBeInstanceOf(DemoQontoClient);
  });
});
