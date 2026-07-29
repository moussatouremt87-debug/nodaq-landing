import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { connectorSecretName, DemoQontoClient } from "@nodaq/mcp-connectors";
import { buildApp } from "../src/app.js";

/*
 * Classeur documentaire photo (ticket 2.16) : capture membre, extraction via
 * un FAUX LiteLLM (jamais de vrai modèle), dédup par empreinte, corrections
 * append-only (apprentissage), rapprochement owner-only, isolation tenant,
 * effacement owner. La photo ne transite JAMAIS dans les listes ni les logs.
 */

const EXTRACTION = {
  docType: "facture_fournisseur",
  supplierName: "Comptoir Elec Distribution",
  pieceNumber: "F-2026-101",
  docDate: "2026-06-10",
  currency: "EUR",
  totalExclTax: 100,
  totalTax: 20,
  totalInclTax: 120,
};

let llmShouldFail = false;
const fakeLiteLLM = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    if (llmShouldFail) {
      res.writeHead(500).end(JSON.stringify({ error: "boom" }));
      return;
    }
    const body = JSON.parse(raw) as { messages?: { content: unknown }[] };
    const vision = Array.isArray(body.messages?.[0]?.content);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: vision ? JSON.stringify(EXTRACTION) : "interne" } }],
      }),
    );
  });
});

/** Un « JPEG » minimal : les magic bytes suffisent (le modèle est bouchonné). */
function fakeJpeg(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed, "utf8")]);
}

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

function upload(content: Buffer, cookie: string, fileName = "recu-chantier.jpg") {
  return app.inject({
    method: "POST",
    url: "/classeur/documents",
    headers: {
      cookie,
      "content-type": "application/octet-stream",
      "x-doc-filename": encodeURIComponent(fileName),
    },
    payload: content,
  });
}

// Identifiants uniques par exécution (pas de purge globale des users : course
// avec les autres suites qui tournent en parallèle).
const RUN = Date.now().toString(36);

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeLiteLLM.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLLM.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test-master";

  admin = createAdminClient();
  await admin.classeurDocument.deleteMany();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`classeur-owner-${RUN}@example.com`, "Classeur Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Classeur ${RUN}`, slug: `org-classeur-${RUN}` },
  });
  orgA = org.json().id as string;

  otherCookie = await signup(`classeur-other-${RUN}@example.com`, "Classeur Other");
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: otherCookie },
    payload: { name: `Org Classeur B ${RUN}`, slug: `org-classeur-b-${RUN}` },
  });

  memberCookie = await signup(`classeur-member-${RUN}@example.com`, "Classeur Member");
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
  fakeLiteLLM.close();
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("capture et extraction", () => {
  let docId: string;

  it("401 sans session ; 415 si les octets ne sont pas une image", async () => {
    const anonymous = await app.inject({
      method: "POST",
      url: "/classeur/documents",
      headers: { "content-type": "application/octet-stream" },
      payload: fakeJpeg("x"),
    });
    expect(anonymous.statusCode).toBe(401);

    const notImage = await upload(Buffer.from("pas une image du tout"), memberCookie);
    expect(notImage.statusCode).toBe(415);
  });

  it("un MEMBRE capture : 201, champs extraits par le tier souverain, statut a_verifier", async () => {
    const res = await upload(fakeJpeg("recu-1"), memberCookie);
    expect(res.statusCode).toBe(201);
    const { document } = res.json();
    docId = document.id as string;
    expect(document).toMatchObject({
      fileName: "recu-chantier.jpg",
      mimeType: "image/jpeg",
      docType: "facture_fournisseur",
      status: "a_verifier",
    });
    expect(document.extraction).toMatchObject({ supplierName: EXTRACTION.supplierName, totalInclTax: 120 });
    expect(document.originalExtraction).toMatchObject({ totalInclTax: 120 });
    // La photo ne sort JAMAIS dans les réponses JSON.
    expect(res.body).not.toContain(fakeJpeg("recu-1").toString("base64"));

    const list = await app.inject({
      method: "GET",
      url: "/classeur/documents",
      headers: { cookie: memberCookie },
    });
    expect(list.json().documents.map((d: { id: string }) => d.id)).toContain(docId);
    expect(list.body).not.toContain("photo");
  });

  it("dédup par empreinte : re-photographier le même fichier = no-op signalé", async () => {
    const res = await upload(fakeJpeg("recu-1"), memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyImported).toBe(true);
    expect(await admin.classeurDocument.count({ where: { tenantId: orgA } })).toBe(1);
  });

  it("la photo est servie au tenant avec son vrai content-type", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/classeur/documents/${docId}/photo`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.rawPayload.equals(fakeJpeg("recu-1"))).toBe(true);
  });

  it("échec du modèle => document stocké quand même, extraction nulle (à saisir)", async () => {
    llmShouldFail = true;
    try {
      const res = await upload(fakeJpeg("recu-sans-modele"), memberCookie, "recu2.jpg");
      expect(res.statusCode).toBe(201);
      expect(res.json().document.extraction).toBeNull();
      expect(res.json().document.status).toBe("a_verifier");
    } finally {
      llmShouldFail = false;
    }
  });

  it("correction append-only : extraction à jour, original FIGÉ, statut verifie", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/classeur/documents/${docId}`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { totalInclTax: 121.5, supplierName: "Comptoir Élec" },
    });
    expect(res.statusCode).toBe(200);
    const { document } = res.json();
    expect(document.extraction).toMatchObject({ totalInclTax: 121.5, supplierName: "Comptoir Élec" });
    expect(document.originalExtraction).toMatchObject({ totalInclTax: 120 });
    expect(document.status).toBe("verifie");
    expect(document.corrections).toHaveLength(1);
    expect(document.corrections[0]).toMatchObject({ fields: { totalInclTax: 121.5 } });
    expect(document.corrections[0].by).toBeTruthy();
    expect(document.corrections[0].at).toBeTruthy();

    // Champ inconnu => 400 (.strict()).
    const bad = await app.inject({
      method: "PATCH",
      url: `/classeur/documents/${docId}`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { photo: "hack" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("rapprochement : owner only, candidats issus de la banque, confirmation 1 clic", async () => {
    const memberDenied = await app.inject({
      method: "GET",
      url: `/classeur/documents/${docId}/candidates`,
      headers: { cookie: memberCookie },
    });
    expect(memberDenied.statusCode).toBe(403);

    // Sans banque connectée : réponse claire, pas d'erreur.
    const noBank = await app.inject({
      method: "GET",
      url: `/classeur/documents/${docId}/candidates`,
      headers: { cookie: ownerCookie },
    });
    expect(noBank.json()).toEqual({ candidates: [], reason: "no-bank" });

    // Connecteur démo (fixtures en mémoire, zéro réseau) : on aligne le
    // montant du document sur une vraie transaction débit de la démo.
    await admin.connector.create({
      data: {
        tenantId: orgA,
        type: "qonto",
        status: "demo",
        credentialsRef: connectorSecretName(orgA, "qonto"),
      },
    });
    const demoTx = (await new DemoQontoClient().listTransactions({ perPage: 100 })).transactions.find(
      (t) => t.side === "debit" && (t.transaction_id ?? t.id),
    );
    expect(demoTx).toBeDefined();
    await app.inject({
      method: "PATCH",
      url: `/classeur/documents/${docId}`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { totalInclTax: (demoTx?.amount_cents ?? 0) / 100 },
    });

    const candidates = await app.inject({
      method: "GET",
      url: `/classeur/documents/${docId}/candidates`,
      headers: { cookie: ownerCookie },
    });
    expect(candidates.statusCode).toBe(200);
    const first = candidates.json().candidates[0];
    expect(first).toMatchObject({ amountCents: demoTx?.amount_cents });

    const match = await app.inject({
      method: "POST",
      url: `/classeur/documents/${docId}/match`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { transactionId: first.transactionId },
    });
    expect(match.statusCode).toBe(200);
    expect(match.json().document).toMatchObject({
      status: "rapproche",
      matchedTransactionId: first.transactionId,
    });
  });

  it("isolation : le tenant B ne voit ni la liste ni la photo", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/classeur/documents",
      headers: { cookie: otherCookie },
    });
    expect(list.json().documents).toEqual([]);

    const photo = await app.inject({
      method: "GET",
      url: `/classeur/documents/${docId}/photo`,
      headers: { cookie: otherCookie },
    });
    expect(photo.statusCode).toBe(404);
  });

  it("effacement : membre 403, owner 204, photo réellement supprimée", async () => {
    const member = await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${docId}`,
      headers: { cookie: memberCookie },
    });
    expect(member.statusCode).toBe(403);

    const owner = await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${docId}`,
      headers: { cookie: ownerCookie },
    });
    expect(owner.statusCode).toBe(204);
    expect(await admin.classeurDocument.findUnique({ where: { id: docId } })).toBeNull();
  });
});
