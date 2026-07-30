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
  DEMO_SILAE_EMPLOYEES,
  DemoSilaeClient,
  demoQontoTransactions,
  demoSilaeAbsences,
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

  it("Silae (3.10) : 4 électriciens à 35 h/semaine", () => {
    expect(DEMO_SILAE_EMPLOYEES).toHaveLength(4);
    for (const employee of DEMO_SILAE_EMPLOYEES) {
      expect(employee.weekly_hours).toBe(35);
      expect(employee.active).toBe(true);
    }
  });

  it("Silae (3.10) : 2 absences, l'une à cheval sur le mois prochain", () => {
    const now = new Date("2026-07-30T12:00:00Z");
    const absences = demoSilaeAbsences(now);
    expect(absences).toHaveLength(2);
    // Le premier arrêt reste entièrement DANS le mois courant.
    const withinMonth = absences.find((a) => a.type === "maladie");
    expect(withinMonth?.start_date.slice(0, 7)).toBe("2026-07");
    expect(withinMonth?.end_date.slice(0, 7)).toBe("2026-07");
    // Les congés payés démarrent en juillet et finissent en août : à CHEVAL.
    const crossing = absences.find((a) => a.type === "conges_payes");
    expect(crossing?.start_date.slice(0, 7)).toBe("2026-07");
    expect(crossing?.end_date.slice(0, 7)).toBe("2026-08");
    expect(crossing?.start_date < crossing!.end_date).toBe(true);
    // Toujours vrai en décembre : Date.UTC normalise le débordement d'année.
    const december = demoSilaeAbsences(new Date("2026-12-15T00:00:00Z"));
    const crossingDecember = december.find((a) => a.type === "conges_payes");
    expect(crossingDecember?.start_date.slice(0, 7)).toBe("2026-12");
    expect(crossingDecember?.end_date.slice(0, 7)).toBe("2027-01");
  });
});

describe("DemoSilaeClient", () => {
  it("sert les 4 salariés fixtures, zéro réseau, zéro secret", async () => {
    const client = new DemoSilaeClient();
    const { items, next_cursor } = await client.listEmployees();
    expect(items).toHaveLength(4);
    expect(next_cursor).toBeNull();
    expect(items.every((e) => e.weekly_hours === 35 && e.active)).toBe(true);
  });

  it("pagine par curseur (offset)", async () => {
    const client = new DemoSilaeClient();
    const page1 = await client.listEmployees({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBe("2");
    const page2 = await client.listEmployees({ limit: 2, cursor: page1.next_cursor ?? undefined });
    expect(page2.items).toHaveLength(2);
    expect(page2.next_cursor).toBeNull();
  });

  it("sert les absences fixtures et filtre par from/to", async () => {
    const clock = () => new Date("2026-07-30T12:00:00Z");
    const client = new DemoSilaeClient(clock);
    const { items } = await client.listAbsences();
    expect(items).toHaveLength(2);
    // Filtre resserré au mois d'août seul : ne garde que les congés (fin en août).
    const augustOnly = await client.listAbsences({ from: "2026-08-01", to: "2026-08-31" });
    expect(augustOnly.items).toHaveLength(1);
    expect(augustOnly.items[0]?.type).toBe("conges_payes");
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

  it("pennylane : 22 factures (7 récentes + 12 mois d'historique + 3 dormantes) dont 3 en retard totalisant 8 030 €", async () => {
    const pennylane = await getPennylaneClient(tenantDemo, { secretProvider: explodingVault });
    const { items } = await pennylane.listCustomerInvoices({ limit: 100 });
    // 7 récentes + 12 mensuelles payées (prévision 3.1) + 3 anciennes payées
    // d'un client devenu silencieux (cas « à risque » des signaux clients 3.4).
    expect(items).toHaveLength(22);
    expect(items.filter((i) => i.id.startsWith("inv-hist-"))).toHaveLength(12);
    // Signaux clients (3.4) : chaque facture démo est attribuée à un client,
    // et le client dormant n'apparaît que sur les factures anciennes payées.
    expect(items.every((i) => i.customer?.id)).toBe(true);
    const dormant = items.filter((i) => i.customer?.id === "cus-4");
    expect(dormant).toHaveLength(3);
    expect(dormant.every((i) => i.status === "paid")).toBe(true);
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
