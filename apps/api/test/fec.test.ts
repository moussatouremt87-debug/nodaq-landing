import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { getPennylaneClient } from "@nodaq/mcp-connectors";
import { claimableCents } from "@nodaq/mcp-actions";
import { buildApp } from "../src/app.js";

/*
 * Import FEC (ticket 2.14) : owner-only, idempotent par empreinte,
 * remplacement intégral, rejet franc (422) SANS écho du contenu, isolation
 * tenant, et repli « connecteur fichier » dans le registre Pennylane.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let otherCookie: string;
let orgA: string;

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

async function createOrg(cookie: string, name: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie },
    payload: { name, slug },
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

const HEADER =
  "JournalCode\tJournalLib\tEcritureNum\tEcritureDate\tCompteNum\tCompteLib\tCompAuxNum\tCompAuxLib\tPieceRef\tPieceDate\tEcritureLib\tDebit\tCredit\tEcritureLet\tDateLet\tValidDate\tMontantdevise\tIdevise";

function line(parts: {
  num: string;
  date: string;
  compte: string;
  aux?: string;
  auxLib?: string;
  piece: string;
  debit?: string;
  credit?: string;
  let?: string;
}): string {
  return [
    "VE",
    "Ventes",
    parts.num,
    parts.date,
    parts.compte,
    "Compte",
    parts.aux ?? "",
    parts.auxLib ?? "",
    parts.piece,
    parts.date,
    "Ecriture",
    parts.debit ?? "0,00",
    parts.credit ?? "0,00",
    parts.let ?? "",
    "",
    "",
    "",
    "",
  ].join("\t");
}

/** FEC équilibré : 1 facture lettrée + 1 impayée (échue depuis longtemps). */
function fixtureFec(overdueAmount = "980,00"): string {
  return [
    HEADER,
    line({ num: "1", date: "20250110", compte: "41100001", aux: "CDUR", auxLib: "Menuiserie Durand", piece: "FA-1", debit: "500,00", let: "A" }),
    line({ num: "1", date: "20250110", compte: "706000", piece: "FA-1", credit: "500,00" }),
    line({ num: "2", date: "20250201", compte: "41100002", aux: "CLEF", auxLib: "SCI Lefevre", piece: "FA-2", debit: overdueAmount }),
    line({ num: "2", date: "20250201", compte: "706000", piece: "FA-2", credit: overdueAmount }),
  ].join("\r\n");
}

function importFec(content: string, cookie: string, fileName = "123456789FEC20251231.txt") {
  return app.inject({
    method: "POST",
    url: "/connectors/fec/import",
    headers: {
      cookie,
      "content-type": "application/octet-stream",
      "x-fec-filename": encodeURIComponent(fileName),
    },
    payload: Buffer.from(content, "utf-8"),
  });
}

// Identifiants uniques par exécution : pas de purge globale des users (elle
// entrerait en course avec api.test.ts qui tourne en parallèle).
const RUN = Date.now().toString(36);

beforeAll(async () => {
  admin = createAdminClient();
  await admin.fecInvoice.deleteMany();
  await admin.fecImport.deleteMany();
  await admin.connector.deleteMany({ where: { type: "fec" } });
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`fec-owner-${RUN}@example.com`, "Fec Owner");
  orgA = await createOrg(ownerCookie, `Org Fec ${RUN}`, `org-fec-${RUN}`);
  otherCookie = await signup(`fec-other-${RUN}@example.com`, "Fec Other");
  await createOrg(otherCookie, `Org Fec B ${RUN}`, `org-fec-b-${RUN}`);

  memberCookie = await signup(`fec-member-${RUN}@example.com`, "Fec Member");
  const memberId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: memberCookie } })
  ).json().userId as string;
  await admin.membership.create({ data: { tenantId: orgA, userId: memberId, role: "member" } });
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: memberCookie },
    payload: { organizationId: orgA },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

/**
 * Chantier BTP soldé HORS retenue de garantie : 10 000 € facturés, 500 € (5 %)
 * transférés au 4117 jusqu'à la levée des réserves, 9 500 € encaissés.
 * Rien n'est dû aujourd'hui — et rien ne doit être relancé (US-8).
 */
function fixtureRetenue(): string {
  return [
    HEADER,
    line({ num: "1", date: "20250110", compte: "41100003", aux: "CBTP", auxLib: "SCI Chantier", piece: "FA-RG", debit: "10000,00", let: "AA" }),
    line({ num: "1", date: "20250110", compte: "706000", piece: "FA-RG", credit: "10000,00" }),
    line({ num: "2", date: "20250110", compte: "41170003", aux: "CBTP", auxLib: "SCI Chantier", piece: "FA-RG", debit: "500,00" }),
    line({ num: "2", date: "20250110", compte: "41100003", aux: "CBTP", auxLib: "SCI Chantier", piece: "FA-RG", credit: "500,00", let: "AA" }),
    line({ num: "3", date: "20250214", compte: "512000", piece: "REG-RG", debit: "9500,00" }),
    line({ num: "3", date: "20250214", compte: "41100003", aux: "CBTP", auxLib: "SCI Chantier", piece: "FA-RG", credit: "9500,00", let: "AA" }),
  ].join("\r\n");
}

describe("retenue de garantie (US-8) — bout en bout", () => {
  it("BLOQUANT : la facture n'est ni impayée ni relançable, la retenue est dite", async () => {
    const res = await importFec(fixtureRetenue(), ownerCookie, "retenue.txt");
    expect(res.statusCode).toBe(201);
    const report = res.json() as { overdueCount: number; overdueCents: number };
    // Une relance ici ferait perdre un bon client : rien n'est exigible.
    expect(report.overdueCount).toBe(0);
    expect(report.overdueCents).toBe(0);

    // La facture existe, soldée, avec sa retenue conservée à part.
    const invoice = await admin.fecInvoice.findFirstOrThrow({ where: { number: "FA-RG" } });
    expect(invoice.settled).toBe(true);
    expect(Number(invoice.residualCents)).toBe(0);
    expect(Number(invoice.retainedCents)).toBe(50_000);
    // Le montant facturé reste celui du marché, pas 10 500 €.
    expect(Number(invoice.amountCents)).toBe(1_000_000);

    // L'interface facturier ne la présente pas comme en retard : c'est CE
    // statut qui décide d'une proposition de relance.
    const pennylane = await getPennylaneClient(orgA);
    const { items } = await pennylane.listCustomerInvoices({ limit: 50 });
    expect(items.find((i) => i.invoice_number === "FA-RG")?.status).toBe("paid");

    // Et la retenue est VISIBLE, pas silencieusement absorbée.
    const status = await app.inject({
      method: "GET",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });
    const body = status.json() as { retention: { count: number; totalCents: number } };
    expect(body.retention.count).toBe(1);
    expect(body.retention.totalCents).toBe(50_000);
  });

  it("BLOQUANT : sur un chantier NON réglé, l'aval ne peut réclamer que l'exigible", async () => {
    // Même chantier, rien d'encaissé : 10 000 € facturés, 500 € retenus. La
    // facture est bien en retard — mais pour 9 500 €, pas 10 000 €. Le
    // montant du marché reste le montant du marché (il fait le CA) ; la part
    // non exigible voyage À CÔTÉ, jamais fondue dedans.
    const impaye = [
      HEADER,
      line({ num: "1", date: "20250110", compte: "41100009", aux: "CBTP2", piece: "FA-RG2", debit: "10000,00" }),
      line({ num: "1", date: "20250110", compte: "706000", piece: "FA-RG2", credit: "10000,00" }),
      line({ num: "2", date: "20250110", compte: "41170009", aux: "CBTP2", piece: "FA-RG2", debit: "500,00" }),
      line({ num: "2", date: "20250110", compte: "41100009", aux: "CBTP2", piece: "FA-RG2", credit: "500,00" }),
    ].join("\r\n");
    expect((await importFec(impaye, ownerCookie, "retenue-impayee.txt")).statusCode).toBe(201);

    const pennylane = await getPennylaneClient(orgA);
    const { items } = await pennylane.listCustomerInvoices({ limit: 50 });
    const invoice = items.find((i) => i.invoice_number === "FA-RG2");
    expect(invoice?.status).toBe("late");
    expect(invoice?.amount).toBe("10000.00");
    // Le champ qui empêche la relance de réclamer la retenue (2.11 / relance).
    expect(invoice?.retained_amount).toBe("500.00");
    expect(claimableCents(invoice, 1_000_000)).toBe(950_000);
  });
});

describe("POST /connectors/fec/import", () => {
  it("401 sans session, 403 pour un MEMBER (owner only)", async () => {
    const anonymous = await app.inject({
      method: "POST",
      url: "/connectors/fec/import",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(anonymous.statusCode).toBe(401);

    const member = await importFec(fixtureFec(), memberCookie);
    expect(member.statusCode).toBe(403);
  });

  it("importe, dérive et rapporte — compteurs seulement, jamais le contenu", async () => {
    const res = await importFec(fixtureFec(), ownerCookie);
    expect(res.statusCode).toBe(201);
    const report = res.json();
    expect(report).toMatchObject({
      alreadyImported: false,
      entryCount: 4,
      customerCount: 2,
      invoiceCount: 2,
      overdueCount: 1,
      overdueCents: 98_000,
    });
    expect(res.body).not.toContain("Durand");
    expect(res.body).not.toContain("41100001");

    // Connecteur fichier posé : statut "file", jamais "active".
    const connectors = await app.inject({
      method: "GET",
      url: "/connectors",
      headers: { cookie: ownerCookie },
    });
    const fec = connectors.json().connectors.find((c: { type: string }) => c.type === "fec");
    expect(fec?.status).toBe("file");

    // Statut consultable (métadonnées).
    const status = await app.inject({
      method: "GET",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });
    expect(status.json().imported).toBe(true);
    expect(status.json().lastImport.entryCount).toBe(4);
  });

  it("idempotence : ré-importer le même fichier = no-op signalé, zéro doublon", async () => {
    const res = await importFec(fixtureFec(), ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyImported).toBe(true);
    expect(await admin.fecImport.count({ where: { tenantId: orgA } })).toBe(1);
    expect(await admin.fecInvoice.count({ where: { tenantId: orgA } })).toBe(2);
  });

  it("un fichier différent REMPLACE l'import précédent", async () => {
    const res = await importFec(fixtureFec("1240,00"), ownerCookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().overdueCents).toBe(124_000);
    expect(await admin.fecImport.count({ where: { tenantId: orgA } })).toBe(1);
    expect(await admin.fecInvoice.count({ where: { tenantId: orgA } })).toBe(2);
  });

  it("FEC invalide : 422, rapport ligne à ligne, rien d'ingéré", async () => {
    const before = await admin.fecInvoice.count({ where: { tenantId: orgA } });
    const broken = fixtureFec().replace("20250201", "20251399");
    const res = await importFec(broken, ownerCookie);
    expect(res.statusCode).toBe(422);
    expect(res.json().details.length).toBeGreaterThan(0);
    expect(res.json().details[0]).toHaveProperty("line");
    // Aucune ligne du fichier ne transite dans la réponse.
    expect(res.body).not.toContain("Durand");
    expect(res.body).not.toContain("20251399");
    expect(await admin.fecInvoice.count({ where: { tenantId: orgA } })).toBe(before);
  });

  it("isolation : le tenant B ne voit rien", async () => {
    const status = await app.inject({
      method: "GET",
      url: "/connectors/fec",
      headers: { cookie: otherCookie },
    });
    // Retenues à zéro et non « absentes » : un tenant sans import n'a aucune
    // retenue, et le dire vaut mieux qu'un champ manquant à interpréter.
    expect(status.json()).toEqual({
      imported: false,
      lastImport: null,
      retention: { count: 0, totalCents: 0, releaseDateKnown: false },
    });
  });
});

describe("registre — repli connecteur fichier", () => {
  it("sans Pennylane, getPennylaneClient sert les factures dérivées du FEC", async () => {
    const client = await getPennylaneClient(orgA);
    const invoices = await client.listCustomerInvoices({ limit: 10 });
    expect(invoices.items).toHaveLength(2);
    const late = invoices.items.find((i) => i.status === "late");
    expect(late?.invoice_number).toBe("FA-2");
    expect(late?.amount).toBe("1240.00");
    const customers = await client.listCustomers();
    expect(customers.items.map((c) => c.id).sort()).toEqual(["CDUR", "CLEF"]);
  });
});
