import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import type { SecretProvider } from "@nodaq/secrets";
import {
  DEMO_CONNECTOR_STATUS,
  ConnectorNotConfiguredError,
  connectorSecretName,
  getPennylaneClient,
  getQontoClient,
} from "../src/registry.js";
import {
  DEMO_AVG_DAILY_NET_CENTS,
  DEMO_LATE_INVOICES,
  DEMO_LATE_TOTAL_CENTS,
  DEMO_OBSERVED_DAYS,
  DEMO_QONTO_BALANCE_CENTS,
  demoQontoTransactions,
} from "../src/demo.js";

/**
 * Mode démo du registre : un connecteur en statut "demo" sert des fixtures —
 * jamais le coffre, jamais le réseau. Les chiffres sont IMPOSÉS par le kit de
 * démo et verrouillés ici.
 */

const TENANT_DEMO = "Conn Demo";
const TENANT_DEMO_BAD = "Conn Demo Bad";

let admin: PrismaClient;
let tenantDemo: string;
let tenantBad: string;

/** Coffre piégé : la moindre lecture en mode démo est un échec du test. */
const explodingVault: SecretProvider = {
  get() {
    throw new Error("vault must never be read in demo mode");
  },
};

beforeAll(async () => {
  admin = createAdminClient();
  await admin.connector.deleteMany({
    where: { tenant: { name: { in: [TENANT_DEMO, TENANT_DEMO_BAD] } } },
  });
  await admin.tenant.deleteMany({ where: { name: { in: [TENANT_DEMO, TENANT_DEMO_BAD] } } });
  tenantDemo = (await admin.tenant.create({ data: { name: TENANT_DEMO } })).id;
  tenantBad = (await admin.tenant.create({ data: { name: TENANT_DEMO_BAD } })).id;

  await withTenant(tenantDemo, (tx) =>
    tx.connector.createMany({
      data: (["qonto", "pennylane"] as const).map((type) => ({
        tenantId: tenantDemo,
        type,
        status: DEMO_CONNECTOR_STATUS,
        credentialsRef: connectorSecretName(tenantDemo, type),
      })),
    }),
  );
  // Garde-fou : même en "demo", une ref hors namespace tenant est refusée.
  await withTenant(tenantBad, (tx) =>
    tx.connector.create({
      data: {
        tenantId: tenantBad,
        type: "qonto",
        status: DEMO_CONNECTOR_STATUS,
        credentialsRef: connectorSecretName(tenantDemo, "qonto"),
      },
    }),
  );
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("fixtures démo (chiffres du kit, verrouillés)", () => {
  it("total des 3 factures en retard = 8 030,00 €", () => {
    expect(DEMO_LATE_INVOICES).toHaveLength(3);
    expect(DEMO_LATE_TOTAL_CENTS).toBe(803_000);
  });

  it("flux net calibré exactement sur la fenêtre d'observation", () => {
    const txs = demoQontoTransactions();
    const net = txs.reduce(
      (sum, t) => sum + (t.side === "credit" ? t.amountCents : -t.amountCents),
      0,
    );
    expect(net).toBe(DEMO_AVG_DAILY_NET_CENTS * DEMO_OBSERVED_DAYS);
    // Tout tient dans une page de 100 (fenêtre vue par l'outil trésorerie),
    // et la plus ancienne transaction ancre la fenêtre à J-360 pile.
    expect(txs.length).toBeLessThanOrEqual(100);
    expect(Math.ceil(Math.max(...txs.map((t) => t.daysAgo)))).toBe(DEMO_OBSERVED_DAYS);
    for (const t of txs) expect(t.amountCents).toBeGreaterThan(0);
  });
});

describe("registre en mode démo", () => {
  it("qonto : données fictives, zéro lecture du coffre, zéro réseau", async () => {
    const qonto = await getQontoClient(tenantDemo, { secretProvider: explodingVault });
    const { organization } = await qonto.getOrganization();
    expect(organization.bank_accounts[0]?.balance_cents).toBe(DEMO_QONTO_BALANCE_CENTS);
    const { transactions } = await qonto.listTransactions({ perPage: 100 });
    expect(transactions.length).toBeGreaterThanOrEqual(90);
    expect(transactions.every((t) => t.settled_at && t.side)).toBe(true);
  });

  it("pennylane : 7 factures dont 3 en retard totalisant 8 030 €", async () => {
    const pennylane = await getPennylaneClient(tenantDemo, { secretProvider: explodingVault });
    const { items } = await pennylane.listCustomerInvoices({ limit: 100 });
    expect(items).toHaveLength(7);
    const late = items.filter((invoice) => invoice.status === "late");
    expect(late).toHaveLength(3);
    const lateCents = late.reduce(
      (sum, invoice) => sum + Math.round(Number.parseFloat(String(invoice.amount)) * 100),
      0,
    );
    expect(lateCents).toBe(DEMO_LATE_TOTAL_CENTS);
  });

  it("une ref hors namespace reste refusée, même en statut demo", async () => {
    await expect(
      getQontoClient(tenantBad, { secretProvider: explodingVault }),
    ).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
  });
});
