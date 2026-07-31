import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";
import {
  signWebhookPayload,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookRateLimiter,
} from "../src/webhooks.js";

/*
 * Socle webhooks entrants (2.13). Une requête webhook n'a AUCUNE session :
 * la signature HMAC est la seule preuve, le tenant vient de l'ENDPOINT
 * (jamais du corps reçu), et tout échec d'authentification répond un 401
 * constant — ni l'existence de l'endpoint ni la raison ne fuient.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;
const vaultStore = new Map<string, string>();
const handled: { tenantId: string; externalId: string; eventType: string }[] = [];
const RUN = Date.now().toString(36);

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

/** Poste un corps BRUT signé, comme le ferait un fournisseur. */
async function deliver(
  url: string,
  body: Buffer,
  signature: string | undefined,
): Promise<{ statusCode: number; json: () => unknown }> {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "x-nodaq-signature": signature }),
    },
    payload: body,
  });
}

beforeAll(async () => {
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
    webhookHandlers: {
      test: (event) => {
        handled.push({
          tenantId: event.tenantId,
          externalId: event.externalId,
          eventType: event.eventType,
        });
        return Promise.resolve();
      },
    },
  });
  await app.ready();

  ownerCookie = await signup(`wh-owner-${RUN}@example.com`, "Wh Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Wh ${RUN}`, slug: `org-wh-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`wh-member-${RUN}@example.com`, "Wh Member");
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

describe("endpoints webhook — gestion owner", () => {
  it("membre : 403 partout ; provider inconnu : 400", async () => {
    for (const [method, url] of [
      ["POST", "/webhooks/endpoints"],
      ["GET", "/webhooks/endpoints"],
      ["GET", "/webhooks/events"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(method === "POST" ? { payload: { provider: "test" } } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "n-importe-quoi" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("le secret est généré par le serveur, renvoyé UNE fois, jamais relisible", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "test", description: "fournisseur de test" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; secret: string; url: string };
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.url).toBe(`/webhooks/test/${body.id}`);
    // Le secret vit au coffre, jamais en base.
    const row = await admin.webhookEndpoint.findUnique({ where: { id: body.id } });
    expect(row?.secretRef).toBe(`webhook/${orgId}/test`);
    expect(JSON.stringify(row)).not.toContain(body.secret);
    // Et il ne ressort JAMAIS d'une lecture ultérieure.
    const listed = await app.inject({
      method: "GET",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
    });
    expect(JSON.stringify(listed.json())).not.toContain(body.secret);
    expect(JSON.stringify(listed.json())).not.toContain("secretRef");
  });
});

describe("réception webhook — signature, idempotence, tenant", () => {
  let endpointId: string;
  let secret: string;

  beforeAll(async () => {
    const created = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "test" },
    });
    const body = created.json() as { id: string; secret: string };
    endpointId = body.id;
    secret = body.secret;
  });

  it("signature valide : 202, événement stocké, handler métier appelé", async () => {
    const body = Buffer.from(JSON.stringify({ id: `evt-${RUN}-1`, type: "invoice.paid" }));
    const signature = signWebhookPayload(secret, Math.floor(Date.now() / 1000), body);
    const res = await deliver(`/webhooks/test/${endpointId}`, body, signature);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ received: true, duplicate: false });

    const stored = await admin.webhookEvent.findFirst({
      where: { tenantId: orgId, externalId: `evt-${RUN}-1` },
    });
    expect(stored).toMatchObject({ provider: "test", eventType: "invoice.paid" });
    // Le handler tourne APRÈS la réponse : on lui laisse un tour de boucle.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(handled.some((e) => e.externalId === `evt-${RUN}-1` && e.tenantId === orgId)).toBe(true);
    const processed = await admin.webhookEvent.findFirst({
      where: { tenantId: orgId, externalId: `evt-${RUN}-1` },
    });
    expect(processed?.status).toBe("processed");
  });

  it("IDEMPOTENCE : la même livraison rejouée ne crée jamais un second événement", async () => {
    const body = Buffer.from(JSON.stringify({ id: `evt-${RUN}-dup`, type: "x" }));
    const signature = signWebhookPayload(secret, Math.floor(Date.now() / 1000), body);
    const first = await deliver(`/webhooks/test/${endpointId}`, body, signature);
    expect(first.json()).toMatchObject({ duplicate: false });
    const second = await deliver(`/webhooks/test/${endpointId}`, body, signature);
    // 202 quand même : le fournisseur a fait son travail, il ne doit pas
    // ré-essayer en boucle — mais rien n'est écrit une seconde fois.
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ duplicate: true });
    expect(
      await admin.webhookEvent.count({ where: { tenantId: orgId, externalId: `evt-${RUN}-dup` } }),
    ).toBe(1);
  });

  it("401 CONSTANT : mauvaise signature, corps modifié, horodatage rejoué, endpoint inconnu", async () => {
    const body = Buffer.from(JSON.stringify({ id: `evt-${RUN}-ko`, type: "x" }));
    const now = Math.floor(Date.now() / 1000);
    const good = signWebhookPayload(secret, now, body);

    const cases: [string, Buffer, string | undefined][] = [
      // Signature absente.
      [`/webhooks/test/${endpointId}`, body, undefined],
      // Signature d'un AUTRE secret.
      [`/webhooks/test/${endpointId}`, body, signWebhookPayload("b".repeat(64), now, body)],
      // Corps modifié après signature.
      [`/webhooks/test/${endpointId}`, Buffer.from(JSON.stringify({ id: "autre" })), good],
      // Horodatage hors fenêtre (rejeu).
      [
        `/webhooks/test/${endpointId}`,
        body,
        signWebhookPayload(secret, now - WEBHOOK_TOLERANCE_SECONDS - 120, body),
      ],
      // Endpoint inexistant : 401 (surtout PAS 404 — pas d'oracle).
      [`/webhooks/test/11111111-2222-4333-8444-555555555555`, body, good],
      // Provider ne correspondant pas à l'endpoint.
      [`/webhooks/pdp/${endpointId}`, body, good],
    ];
    for (const [url, payload, signature] of cases) {
      const res = await deliver(url, payload, signature);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
    // Aucun de ces refus n'a écrit quoi que ce soit.
    expect(
      await admin.webhookEvent.count({ where: { tenantId: orgId, externalId: `evt-${RUN}-ko` } }),
    ).toBe(0);
  });

  it("le tenant vient de l'ENDPOINT : un tenantId injecté dans le corps n'a aucun effet", async () => {
    const other = await admin.tenant.create({ data: { name: `Org Wh B ${RUN}` } });
    const body = Buffer.from(
      JSON.stringify({ id: `evt-${RUN}-inject`, type: "x", tenantId: other.id, tenant_id: other.id }),
    );
    const signature = signWebhookPayload(secret, Math.floor(Date.now() / 1000), body);
    const res = await deliver(`/webhooks/test/${endpointId}`, body, signature);
    expect(res.statusCode).toBe(202);

    // L'événement appartient au tenant de l'endpoint, PAS à celui du corps.
    const mine = await admin.webhookEvent.findFirst({
      where: { externalId: `evt-${RUN}-inject` },
      select: { tenantId: true },
    });
    expect(mine?.tenantId).toBe(orgId);
    expect(await admin.webhookEvent.count({ where: { tenantId: other.id } })).toBe(0);
  });

  it("corps illisible ou sans identifiant d'événement : 400, rien n'est stocké", async () => {
    const now = Math.floor(Date.now() / 1000);
    const notJson = Buffer.from("pas du json");
    const noId = Buffer.from(JSON.stringify({ type: "sans-id" }));
    for (const payload of [notJson, noId]) {
      const res = await deliver(
        `/webhooks/test/${endpointId}`,
        payload,
        signWebhookPayload(secret, now, payload),
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it("journal des réceptions : métadonnées de traitement, jamais le payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/events",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: { externalId: string; status: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("payload");
    expect(JSON.stringify(body)).not.toContain("invoice.paid" + '","payload');
  });

  it("rotation du secret : l'URL et le JOURNAL survivent, l'ancien secret cesse de marcher", async () => {
    const before = await admin.webhookEvent.count({ where: { tenantId: orgId, provider: "test" } });
    expect(before).toBeGreaterThan(0);
    const oldSecret = secret;

    const rotated = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "test" },
    });
    expect(rotated.statusCode).toBe(201);
    const next = rotated.json() as { id: string; secret: string };
    // Même endpoint (l'URL configurée chez le fournisseur reste valable)…
    expect(next.id).toBe(endpointId);
    expect(next.secret).not.toBe(oldSecret);
    // …et la piste d'audit n'est pas effacée par une rotation.
    expect(await admin.webhookEvent.count({ where: { tenantId: orgId, provider: "test" } })).toBe(
      before,
    );

    // L'ancien secret est révoqué (cache invalidé compris).
    const body = Buffer.from(JSON.stringify({ id: `evt-${RUN}-old`, type: "x" }));
    const now = Math.floor(Date.now() / 1000);
    const stale = await deliver(
      `/webhooks/test/${endpointId}`,
      body,
      signWebhookPayload(oldSecret, now, body),
    );
    expect(stale.statusCode).toBe(401);
    const fresh = await deliver(
      `/webhooks/test/${endpointId}`,
      body,
      signWebhookPayload(next.secret, now, body),
    );
    expect(fresh.statusCode).toBe(202);
    secret = next.secret;
  });

  it("MINIMISATION : sans handler pour le provider, le payload n'est PAS collecté", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "bridge" },
    });
    const { id, secret: bridgeSecret } = created.json() as { id: string; secret: string };
    // Corps chargé de données bancaires : aucune finalité tant qu'aucun
    // handler ne les traite -> la trace de réception reste, la donnée non.
    const body = Buffer.from(
      JSON.stringify({
        id: `evt-${RUN}-minim`,
        type: "account.updated",
        iban: "FR7616798000010000012345678",
        holder: "Jean Dupont",
      }),
    );
    const res = await deliver(
      `/webhooks/bridge/${id}`,
      body,
      signWebhookPayload(bridgeSecret, Math.floor(Date.now() / 1000), body),
    );
    expect(res.statusCode).toBe(202);
    const stored = await admin.webhookEvent.findFirst({
      where: { tenantId: orgId, externalId: `evt-${RUN}-minim` },
    });
    expect(stored?.status).toBe("ignored");
    expect(JSON.stringify(stored?.payload)).not.toContain("FR7616798000010000012345678");
    expect(JSON.stringify(stored?.payload)).not.toContain("Jean Dupont");
    expect(stored?.payload).toEqual({});
  });

  it("débit borné : au-delà du quota, 429 — le pool de connexions est protégé", async () => {
    const limited = buildApp({
      vault: {
        get: (name) => Promise.resolve(vaultStore.get(name)),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      webhookRateLimiter: new WebhookRateLimiter(2, 60_000),
    });
    await limited.ready();
    try {
      const body = Buffer.from(JSON.stringify({ id: "evt-flood", type: "x" }));
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await limited.inject({
          method: "POST",
          url: `/webhooks/test/11111111-2222-4333-8444-555555555555`,
          headers: { "content-type": "application/json" },
          payload: body,
        });
        codes.push(res.statusCode);
      }
      // Les deux premières sont traitées (et refusées en 401, endpoint
      // inconnu), les suivantes n'atteignent JAMAIS la base.
      expect(codes.slice(0, 2)).toEqual([401, 401]);
      expect(codes.slice(2)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it("sans handler enregistré : l'événement est marqué « ignored », jamais perdu", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      headers: { cookie: ownerCookie },
      payload: { provider: "pennylane" },
    });
    const { id, secret: pennySecret } = created.json() as { id: string; secret: string };
    const body = Buffer.from(JSON.stringify({ id: `evt-${RUN}-nohandler`, type: "invoice.created" }));
    const res = await deliver(
      `/webhooks/pennylane/${id}`,
      body,
      signWebhookPayload(pennySecret, Math.floor(Date.now() / 1000), body),
    );
    expect(res.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stored = await admin.webhookEvent.findFirst({
      where: { tenantId: orgId, externalId: `evt-${RUN}-nohandler` },
    });
    expect(stored?.status).toBe("ignored");
  });
});
