import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";
import { signWebhookPayload } from "../src/webhooks.js";

/*
 * Soumission PDP + e-reporting (2.4). Déposer une facture sur le réseau
 * national ENGAGE l'entreprise : irréversible, horodaté, opposable. D'où les
 * invariants testés ici :
 *   - rien ne part sans validation humaine (file de validation) ;
 *   - une facture non conforme n'entre même pas dans la file ;
 *   - un statut entrant ne réécrit JAMAIS l'histoire en arrière, et un
 *     statut inconnu n'est pas deviné ;
 *   - le tenant d'un statut vient de l'ENDPOINT, jamais du corps reçu ;
 *   - l'e-reporting transmet des AGRÉGATS, jamais un détail nominatif.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;
let fakePdp: Server;
/** Corps reçus par la fausse plateforme — sert à prouver la minimisation. */
const received: { url: string; body: unknown }[] = [];
const vaultStore = new Map<string, string>();
const RUN = Date.now().toString(36);

const INVOICE = {
  number: `F-PDP-${RUN}`,
  issueDate: "2026-09-10",
  dueDate: "2026-10-10",
  currency: "EUR",
  operationCategory: "prestation_services",
  seller: {
    name: "Élec Provence SARL",
    siret: "81234567600009",
    vatNumber: "FR12812345676",
    address: { street: "12 rue des Oliviers", postalCode: "13100", city: "Aix", countryCode: "FR" },
  },
  buyer: {
    name: "Boulangerie Martin",
    siret: "52345678800018",
    address: { street: "5 place du Marché", postalCode: "13090", city: "Aix", countryCode: "FR" },
  },
  lines: [
    {
      description: "Mise aux normes tableau",
      quantity: 1,
      unitPriceCents: 90_000,
      vatRate: 20,
      vatCategory: "S",
    },
  ],
  totals: { netCents: 90_000, vatCents: 18_000, grossCents: 108_000, dueCents: 108_000 },
};

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

/** Approuve une action en file — le SEUL chemin d'exécution. */
async function approve(id: string): Promise<{ statusCode: number; json: () => unknown }> {
  return app.inject({
    method: "POST",
    url: `/pending-actions/${id}/approve`,
    headers: { cookie: ownerCookie },
  });
}

beforeAll(async () => {
  fakePdp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      received.push({
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as unknown) : null,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/account") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({ id: `pdp-${received.length}`, status: "deposee" }));
    });
  });
  await new Promise<void>((resolve) => fakePdp.listen(0, "127.0.0.1", resolve));
  const pdpBaseUrl = `http://127.0.0.1:${(fakePdp.address() as AddressInfo).port}`;

  admin = createAdminClient();
  app = buildApp({
    vault: {
      get: (name) => Promise.resolve(vaultStore.get(name)),
      set: (name, value) => {
        vaultStore.set(name, value);
        return Promise.resolve();
      },
      delete: (name) => {
        vaultStore.delete(name);
        return Promise.resolve();
      },
    },
    agentContext: { pdpBaseUrl },
  });
  await app.ready();

  ownerCookie = await signup(`pdp-owner-${RUN}@example.com`, "Pdp Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Pdp ${RUN}`, slug: `org-pdp-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`pdp-member-${RUN}@example.com`, "Pdp Member");
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

  // Connecteur PDP : identifiants TESTÉS contre la plateforme puis coffre.
  const connected = await app.inject({
    method: "POST",
    url: "/connectors",
    headers: { cookie: ownerCookie },
    payload: { type: "pdp", credentials: { apiKey: "clef-pdp-de-test", accountId: "ACC-1" } },
  });
  expect(connected.statusCode).toBe(201);
}, 60_000);

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => fakePdp.close(() => resolve()));
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("soumission — owner only, HITL, conformité rejouée", () => {
  it("membre : 403 sur toute la surface de soumission", async () => {
    for (const [method, url, payload] of [
      ["POST", "/factures/soumettre", { invoice: INVOICE }],
      ["GET", "/factures/soumissions", undefined],
      ["GET", "/factures/ereporting/apercu?periodStart=2026-01-01&periodEnd=2026-01-31", undefined],
      ["POST", "/factures/ereporting", undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("facture non conforme : 422 et AUCUNE action en file", async () => {
    const before = await admin.pendingAction.count({ where: { tenantId: orgId } });
    const res = await app.inject({
      method: "POST",
      url: "/factures/soumettre",
      headers: { cookie: ownerCookie },
      payload: {
        // TVA incohérente avec les lignes : bloquant d'audit (2.3).
        invoice: { ...INVOICE, totals: { ...INVOICE.totals, vatCents: 1 } },
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("facture non conforme");
    expect(await admin.pendingAction.count({ where: { tenantId: orgId } })).toBe(before);
  });

  it("facture conforme : file de validation, RIEN n'est déposé avant approbation", async () => {
    const depositsBefore = received.filter((r) => r.url === "/invoices").length;
    const res = await app.inject({
      method: "POST",
      url: "/factures/soumettre",
      headers: { cookie: ownerCookie },
      payload: { invoice: INVOICE },
    });
    expect(res.statusCode).toBe(202);
    const { pendingActionId } = res.json() as { pendingActionId: string };

    // Preuve du HITL : la plateforme n'a rien reçu, aucune soumission créée.
    expect(received.filter((r) => r.url === "/invoices").length).toBe(depositsBefore);
    expect(
      await admin.eInvoiceSubmission.count({ where: { tenantId: orgId, direction: "emission" } }),
    ).toBe(0);

    const approved = await approve(pendingActionId);
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as { status: string }).status).toBe("executed");

    const submission = await admin.eInvoiceSubmission.findFirstOrThrow({
      where: { tenantId: orgId, invoiceNumber: INVOICE.number, direction: "emission" },
    });
    expect(submission.status).toBe("deposee");
    expect(submission.pdpReference).toMatch(/^pdp-/);
    // Preuve d'intégrité, jamais le document : ni PDF ni XML en base.
    expect(submission.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(submission)).not.toContain("%PDF");
    expect(JSON.stringify(submission)).not.toContain("CrossIndustryInvoice");
  });

  it("facture déjà déposée : 409, jamais un second dépôt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/factures/soumettre",
      headers: { cookie: ownerCookie },
      payload: { invoice: INVOICE },
    });
    expect(res.statusCode).toBe(409);
  });

  it("course : une seconde action approuvée ne dépose PAS une seconde fois", async () => {
    // On court-circuite la garde 409 de la route (qui n'est qu'un confort)
    // pour reproduire la vraie course : deux actions en file pour la même
    // facture. La garantie DURE est la réservation atomique côté exécuteur.
    const owner = await admin.membership.findFirstOrThrow({
      where: { tenantId: orgId, role: "owner" },
      select: { userId: true },
    });
    const rogue = await admin.pendingAction.create({
      data: {
        tenantId: orgId,
        type: "submit_einvoice",
        requestedBy: owner.userId,
        employee: "compta",
        payload: { invoice: INVOICE, profile: "EN16931" },
      },
      select: { id: true },
    });
    const depositsBefore = received.filter((r) => r.url === "/invoices").length;
    const approved = await approve(rogue.id);
    expect((approved.json() as { status: string }).status).toBe("failed");
    // RIEN n'est parti sur le réseau, et la référence du premier dépôt tient.
    expect(received.filter((r) => r.url === "/invoices").length).toBe(depositsBefore);
    expect(
      await admin.eInvoiceSubmission.count({
        where: { tenantId: orgId, invoiceNumber: INVOICE.number, direction: "emission" },
      }),
    ).toBe(1);
  });

  it("action terminée : la facture du client ne reste pas en file", async () => {
    const action = await admin.pendingAction.findFirstOrThrow({
      where: { tenantId: orgId, type: "submit_einvoice", status: "executed" },
      select: { payload: true },
    });
    const payload = JSON.stringify(action.payload);
    // Le numéro reste (lecture de la file) ; le client, lui, s'en va.
    expect(payload).toContain(INVOICE.number);
    expect(payload).not.toContain("Boulangerie");
    expect(payload).not.toContain("52345678800018");
    expect(payload).not.toContain("Mise aux normes");
  });

  it("suivi : métadonnées seulement, jamais le document", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/factures/soumissions",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { invoiceNumber: string; status: string }[] };
    expect(body.items.some((item) => item.invoiceNumber === INVOICE.number)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("%PDF");
    // Cache interdit : numéros et montants de factures.
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("statuts entrants — webhook signé, transitions gardées", () => {
  let endpointUrl: string;
  let secret: string;
  let reference: string;

  beforeAll(async () => {
    const created = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "pdp", description: "plateforme de test" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { url: string; secret: string };
    endpointUrl = body.url;
    secret = body.secret;
    const submission = await admin.eInvoiceSubmission.findFirstOrThrow({
      where: { tenantId: orgId, invoiceNumber: INVOICE.number },
    });
    reference = submission.pdpReference ?? "";
  });

  /** Livre un statut signé et attend que le handler (post-réponse) ait fini. */
  async function deliverStatus(payload: { id: string } & object): Promise<number> {
    const raw = Buffer.from(JSON.stringify(payload));
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: "POST",
      url: endpointUrl,
      headers: {
        "content-type": "application/json",
        "x-nodaq-signature": signWebhookPayload(secret, timestamp, raw),
      },
      payload: raw,
    });
    // Le handler tourne APRÈS la réponse (2.13) : on attend son verdict.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const event = await admin.webhookEvent.findFirst({
        where: { tenantId: orgId, externalId: payload.id },
        select: { status: true },
      });
      if (event && event.status !== "received") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return res.statusCode;
  }

  async function currentStatus(): Promise<string> {
    const row = await admin.eInvoiceSubmission.findFirstOrThrow({
      where: { tenantId: orgId, invoiceNumber: INVOICE.number },
    });
    return row.status;
  }

  it("un statut avancé est appliqué et historisé", async () => {
    expect(await deliverStatus({ id: `evt-1-${RUN}`, type: "invoice.status", reference, status: "approved" })).toBe(202);
    expect(await currentStatus()).toBe("approuvee");
    const row = await admin.eInvoiceSubmission.findFirstOrThrow({
      where: { tenantId: orgId, invoiceNumber: INVOICE.number },
    });
    const history = row.statusHistory as { status: string }[];
    expect(history.map((entry) => entry.status)).toContain("approuvee");
  });

  it("un statut en ARRIÈRE est ignoré : un rejeu ne réécrit pas l'histoire", async () => {
    expect(await deliverStatus({ id: `evt-2-${RUN}`, type: "invoice.status", reference, status: "deposee" })).toBe(202);
    expect(await currentStatus()).toBe("approuvee");
  });

  it("`erreur` n'est jamais accepté d'une plateforme : ce n'est pas un verdict", async () => {
    // Sinon un message signé ferait retomber une facture approuvée en
    // « erreur de transmission », puis rouvrirait le cycle depuis erreur.
    expect(
      await deliverStatus({ id: `evt-err-${RUN}`, type: "invoice.status", reference, status: "erreur" }),
    ).toBe(202);
    expect(await currentStatus()).toBe("approuvee");
  });

  it("l'historique est APPEND-ONLY : le dépôt initial n'est pas effacé", async () => {
    const row = await admin.eInvoiceSubmission.findFirstOrThrow({
      where: { tenantId: orgId, invoiceNumber: INVOICE.number },
    });
    const statuses = (row.statusHistory as { status: string }[]).map((entry) => entry.status);
    expect(statuses).toContain("deposee");
    expect(statuses).toContain("approuvee");
  });

  it("un statut INCONNU n'est jamais deviné", async () => {
    expect(
      await deliverStatus({ id: `evt-3-${RUN}`, type: "invoice.status", reference, status: "zzz-inconnu" }),
    ).toBe(202);
    expect(await currentStatus()).toBe("approuvee");
  });

  it("une référence d'un AUTRE tenant ne touche rien : le tenant vient de l'endpoint", async () => {
    // Soumission d'un tenant tiers, insérée en admin (hors RLS).
    const other = await admin.tenant.create({
      data: { id: crypto.randomUUID(), name: `Org Autre ${RUN}`, slug: `org-autre-pdp-${RUN}` },
    });
    const foreign = await admin.eInvoiceSubmission.create({
      data: {
        tenantId: other.id,
        invoiceNumber: `F-AUTRE-${RUN}`,
        profile: "EN16931",
        direction: "emission",
        status: "deposee",
        pdpReference: `pdp-autre-${RUN}`,
        documentHash: "a".repeat(64),
        amountCents: 1_000,
        currency: "EUR",
      },
    });
    expect(
      await deliverStatus({
        id: `evt-4-${RUN}`,
        type: "invoice.status",
        reference: foreign.pdpReference,
        status: "approved",
      }),
    ).toBe(202);
    const after = await admin.eInvoiceSubmission.findUniqueOrThrow({ where: { id: foreign.id } });
    // L'endpoint appartient à orgId : la soumission d'un autre tenant est
    // invisible, donc intouchable.
    expect(after.status).toBe("deposee");
    await admin.eInvoiceSubmission.delete({ where: { id: foreign.id } });
    await admin.tenant.delete({ where: { id: other.id } });
  });
});

describe("e-reporting — agrégats seulement", () => {
  const period = { periodStart: "2026-01-01", periodEnd: "2026-01-31" };

  it("TVA supérieure au total : refus", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/factures/ereporting",
      headers: { cookie: ownerCookie },
      payload: { ...period, totalCents: 100_00, vatCents: 200_00, transactionCount: 3 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("transmission : validée par l'humain, agrégats seuls sur le fil", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/factures/ereporting",
      headers: { cookie: ownerCookie },
      payload: { ...period, totalCents: 12_000_00, vatCents: 2_000_00, transactionCount: 42 },
    });
    expect(res.statusCode).toBe(202);
    const { pendingActionId } = res.json() as { pendingActionId: string };
    const approved = await approve(pendingActionId);
    expect((approved.json() as { status: string }).status).toBe("executed");

    const sent = received.filter((r) => r.url === "/ereporting").at(-1);
    expect(sent).toBeDefined();
    const body = sent?.body as Record<string, unknown>;
    expect(body.transaction_count).toBe(42);
    expect(body.total_amount).toBe("12000.00");
    // Minimisation STRUCTURELLE : aucun nom de client, aucune ligne.
    expect(JSON.stringify(body)).not.toContain("Boulangerie");
    expect(JSON.stringify(body)).not.toContain("Mise aux normes");

    const row = await admin.eInvoiceSubmission.findFirstOrThrow({
      where: { tenantId: orgId, direction: "ereporting" },
    });
    expect(row.invoiceNumber).toBe(`${period.periodStart}..${period.periodEnd}`);
    expect(row.amountCents).toBe(12_000_00);
  });

  it("période déjà transmise : 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/factures/ereporting",
      headers: { cookie: ownerCookie },
      payload: { ...period, totalCents: 12_000_00, vatCents: 2_000_00, transactionCount: 42 },
    });
    expect(res.statusCode).toBe(409);
  });
});
