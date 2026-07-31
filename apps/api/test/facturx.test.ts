import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Factur-X (2.3) : la facture au format légal de la réforme. L'audit de
 * conformité passe AVANT la génération — une facture incohérente n'est
 * jamais produite, elle est refusée avec ses motifs. Les données de
 * facturation sont des données client : rien ne doit fuir en réponse
 * d'erreur ni en log.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;

const RUN = Date.now().toString(36);

const INVOICE = {
  number: "F-2026-0500",
  issueDate: "2026-08-20",
  dueDate: "2026-09-20",
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

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`fx-owner-${RUN}@example.com`, "Fx Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Fx ${RUN}`, slug: `org-fx-${RUN}` },
  });
  const orgId = org.json().id as string;

  memberCookie = await signup(`fx-member-${RUN}@example.com`, "Fx Member");
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
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("POST /factures/facturx", () => {
  it("émission réservée au dirigeant ; payload invalide = 400 sans écho des données", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/factures/facturx",
      headers: { cookie: memberCookie },
      payload: { invoice: INVOICE },
    });
    expect(forbidden.statusCode).toBe(403);

    const bad = await app.inject({
      method: "POST",
      url: "/factures/facturx",
      headers: { cookie: ownerCookie },
      payload: { invoice: { number: "X" } },
    });
    expect(bad.statusCode).toBe(400);
    // La réponse ne renvoie NI les champs reçus NI un rapport Zod détaillé.
    expect(JSON.stringify(bad.json())).not.toContain("number");
  });

  it("facture conforme : PDF avec XML Factur-X embarqué, profil demandé respecté", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/factures/facturx",
      headers: { cookie: ownerCookie },
      payload: { invoice: INVOICE, profile: "EN16931" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      profile: string;
      rulesVersion: string;
      pdfBase64: string;
      xml: string;
      fileName: string;
      audit: { issuable: boolean };
    };
    expect(body.profile).toBe("EN16931");
    expect(body.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.audit.issuable).toBe(true);
    expect(body.fileName).toBe("facture-F-2026-0500.pdf");
    expect(body.xml).toContain("urn:cen.eu:en16931:2017");
    expect(body.xml).toContain("<ram:GrandTotalAmount>1080.00</ram:GrandTotalAmount>");

    const pdf = Buffer.from(body.pdfBase64, "base64");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Marqueur Factur-X (le fichier ne revendique PAS une conformité PDF/A
    // non vérifiée — voir docs/facturx.md).
    expect(pdf.toString("latin1")).toContain("<fx:DocumentType>INVOICE</fx:DocumentType>");
  });

  it("REFUS : une facture incohérente n'est jamais générée, les motifs sont rendus", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/factures/facturx",
      headers: { cookie: ownerCookie },
      payload: {
        invoice: { ...INVOICE, totals: { ...INVOICE.totals, vatCents: 999 } },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { audit: { issues: { code: string; severity: string }[] } };
    expect(body.audit.issues.some((i) => i.code === "tva_incoherente")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("pdfBase64");
  });

  it("aller-retour : la facture générée est relisible par la route de réception", async () => {
    const generated = await app.inject({
      method: "POST",
      url: "/factures/facturx",
      headers: { cookie: ownerCookie },
      payload: { invoice: INVOICE },
    });
    const { pdfBase64, xml } = generated.json() as { pdfBase64: string; xml: string };

    // La lecture est ouverte aux membres : recevoir une facture n'est pas un
    // acte de gestion (obligation de réception au 01/09/2026).
    const read = await app.inject({
      method: "POST",
      url: "/factures/facturx/lire",
      headers: { cookie: memberCookie },
      payload: { pdfBase64 },
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { xml: string }).xml).toBe(xml);

    // Un PDF sans données Factur-X : refus explicite, jamais un XML fabriqué.
    const notFacturX = await app.inject({
      method: "POST",
      url: "/factures/facturx/lire",
      headers: { cookie: memberCookie },
      payload: { pdfBase64: Buffer.from("pas un pdf").toString("base64") },
    });
    expect(notFacturX.statusCode).toBe(422);
  });
});
