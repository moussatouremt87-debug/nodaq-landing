import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";
import {
  buildPushPayload,
  flushTenantPushWindows,
  markPushSeen,
  PushPayload,
  recordPushEvent,
} from "../src/push.js";
import type { PushEndpoint, PushSendResult } from "../src/push.js";

/*
 * Notifications push (ticket 2.17). Les décisions non négociables, testées :
 * 1. GARDE PAYLOAD STRUCTURELLE : rien d'autre que {type, count, deepLink}
 *    ne peut partir vers un service push — jamais un nom, un montant.
 * 2. REGROUPEMENT : une rafale d'événements = UNE notification avec compteur,
 *    et pas de re-notification tant que la file n'a pas été ouverte.
 * 3. Opt-in par appareil et par type ; révocation ; endpoint mort nettoyé.
 * 4. Isolation : les événements d'un tenant ne touchent jamais les appareils
 *    d'un autre.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let otherCookie: string;
let orgA: string;
let orgB: string;
let ownerId: string;
let memberId: string;


const RUN = Date.now().toString(36);
const WINDOW_MS = 15 * 60_000;

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

/** Envoyeur factice : capture tout, résultat programmable par endpoint. */
function fakeSender(results: Record<string, PushSendResult> = {}) {
  const sends: { endpoint: string; payload: PushPayload }[] = [];
  return {
    sends,
    sender: (target: PushEndpoint, payload: PushPayload): Promise<PushSendResult> => {
      sends.push({ endpoint: target.endpoint, payload });
      return Promise.resolve(results[target.endpoint] ?? "ok");
    },
  };
}

async function subscribe(
  cookie: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/push/subscriptions",
    headers: { cookie },
    payload: {
      endpoint,
      keys: { p256dh: "p256dh-test-key", auth: "auth-test-secret" },
      userAgent: "Test Browser",
      ...extra,
    },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  // Clés VAPID factices : la feature est « configurée » pour la suite du
  // fichier (le cas non-configuré est testé explicitement en les retirant).
  process.env.PUSH_VAPID_PUBLIC_KEY = "test-public-key";
  process.env.PUSH_VAPID_PRIVATE_KEY = "test-private-key";

  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`push-owner-${RUN}@example.com`, "Push Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Push ${RUN}`, slug: `org-push-${RUN}` },
  });
  orgA = org.json().id as string;
  ownerId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: ownerCookie } })
  ).json().userId as string;

  memberCookie = await signup(`push-member-${RUN}@example.com`, "Push Member");
  memberId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: memberCookie } })
  ).json().userId as string;
  await admin.membership.create({ data: { tenantId: orgA, userId: memberId, role: "member" } });
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: memberCookie },
    payload: { organizationId: orgA },
  });

  otherCookie = await signup(`push-other-${RUN}@example.com`, "Push Other");
  const orgOther = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: otherCookie },
    payload: { name: `Org Push B ${RUN}`, slug: `org-push-b-${RUN}` },
  });
  orgB = orgOther.json().id as string;
}, 60_000);

afterAll(async () => {
  delete process.env.PUSH_VAPID_PUBLIC_KEY;
  delete process.env.PUSH_VAPID_PRIVATE_KEY;
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("garde structurelle du payload", () => {
  it("le payload est clos : type + compteur + deep-link d'allowlist, RIEN d'autre", () => {
    expect(buildPushPayload("actions", 5)).toEqual({
      type: "actions_en_attente",
      count: 5,
      deepLink: "/validation",
    });
    expect(buildPushPayload("alerts", 2)).toEqual({
      type: "alerte_urgente",
      count: 2,
      deepLink: "/",
    });
    // Un champ métier glissé dans un payload est REJETÉ par le schéma strict
    // (la garde est structurelle, pas une convention de relecture).
    expect(
      PushPayload.safeParse({
        type: "actions_en_attente",
        count: 1,
        deepLink: "/validation",
        customerName: "ACME SARL",
      }).success,
    ).toBe(false);
    expect(
      PushPayload.safeParse({ type: "actions_en_attente", count: 1, deepLink: "https://evil" })
        .success,
    ).toBe(false);
  });
});

describe("opt-in, préférences, révocation", () => {
  it("sans clés VAPID : 503 explicite, jamais un échec silencieux", async () => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    try {
      const config = await app.inject({
        method: "GET",
        url: "/push/config",
        headers: { cookie: ownerCookie },
      });
      expect(config.json()).toMatchObject({ configured: false });
      const res = await subscribe(ownerCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/none`);
      expect(res.statusCode).toBe(503);
    } finally {
      process.env.PUSH_VAPID_PUBLIC_KEY = "test-public-key";
      process.env.PUSH_VAPID_PRIVATE_KEY = "test-private-key";
    }
  });

  it("souscription : clés stockées mais JAMAIS renvoyées ; liste = ses appareils à soi", async () => {
    const created = await subscribe(ownerCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/owner-1`);
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toHaveProperty("endpoint");
    expect(created.body).not.toHaveProperty("p256dh");
    expect(created.body).not.toHaveProperty("auth");
    expect(created.body).toMatchObject({ userAgent: "Test Browser", actionsEnabled: true });

    await subscribe(memberCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/member-1`);
    const list = await app.inject({
      method: "GET",
      url: "/push/subscriptions",
      headers: { cookie: ownerCookie },
    });
    const devices = list.json() as { id: string }[];
    // L'owner ne voit que SES appareils — pas ceux du membre.
    expect(devices).toHaveLength(1);
    expect(devices[0]!.id).toBe(created.body.id);
  });

  it("anti-SSRF : seuls les services push des navigateurs sont acceptés comme endpoint", async () => {
    // Hôte arbitraire, IP interne, http : tous rejetés — le serveur émettra
    // des requêtes vers cette URL, elle ne peut pas être libre.
    for (const endpoint of [
      "https://evil.example/collect",
      "https://169.254.169.254/latest/meta-data",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
    ]) {
      const res = await subscribe(ownerCookie, endpoint);
      expect(res.statusCode).toBe(400);
    }
    // Les vrais services passent.
    const firefox = await subscribe(
      ownerCookie,
      `https://updates.push.services.mozilla.com/wpush/v2/${RUN}`,
    );
    expect(firefox.statusCode).toBe(201);
    await app.inject({
      method: "DELETE",
      url: `/push/subscriptions/${firefox.body.id as string}`,
      headers: { cookie: ownerCookie },
    });
  });

  it("plafond d'appareils par utilisateur : 429 au-delà de la limite", async () => {
    const created: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await subscribe(memberCookie, `https://fcm.googleapis.com/fcm/send/${RUN}-cap-${i}`);
      if (res.statusCode === 201) created.push(res.body.id as string);
    }
    const overflow = await subscribe(
      memberCookie,
      `https://fcm.googleapis.com/fcm/send/${RUN}-cap-over`,
    );
    expect(overflow.statusCode).toBe(429);
    for (const id of created) {
      await app.inject({
        method: "DELETE",
        url: `/push/subscriptions/${id}`,
        headers: { cookie: memberCookie },
      });
    }
  });

  it("re-souscription du même endpoint par un AUTRE utilisateur : 409, pas de transfert", async () => {
    const stolen = await subscribe(memberCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/owner-1`);
    expect(stolen.statusCode).toBe(409);
  });

  it("préférences par type et révocation, scopées à l'utilisateur de session", async () => {
    const created = await subscribe(ownerCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/owner-prefs`);
    const id = created.body.id as string;
    // Le membre ne peut ni régler ni révoquer l'appareil de l'owner.
    const foreignPatch = await app.inject({
      method: "PATCH",
      url: `/push/subscriptions/${id}`,
      headers: { cookie: memberCookie },
      payload: { alertsEnabled: false },
    });
    expect(foreignPatch.statusCode).toBe(404);
    const patch = await app.inject({
      method: "PATCH",
      url: `/push/subscriptions/${id}`,
      headers: { cookie: ownerCookie },
      payload: { alertsEnabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: `/push/subscriptions/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/push/subscriptions",
      headers: { cookie: ownerCookie },
    });
    expect((list.json() as { id: string }[]).some((d) => d.id === id)).toBe(false);
  });
});

describe("regroupement anti-spam", () => {
  it("5 événements -> UNE notification count=5 ; silence ensuite tant que la file n'est pas ouverte", async () => {
    // Chronologie ancrée dans le PASSÉ : les routes (marquage « vu ») datent
    // à l'horloge réelle — un envoi daté du futur bloquerait tout à tort.
    const t0 = new Date(Date.now() - 3 * 60 * 60_000);
    for (let i = 0; i < 5; i++) {
      await recordPushEvent(orgA, [ownerId], "actions", 1, { now: t0 });
    }
    const { sends, sender } = fakeSender();

    // Fenêtre non échue : rien ne part.
    expect(await flushTenantPushWindows(orgA, sender, t0)).toBe(0);

    const afterWindow = new Date(t0.getTime() + WINDOW_MS + 60_000);
    expect(await flushTenantPushWindows(orgA, sender, afterWindow)).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({
      type: "actions_en_attente",
      count: 5,
      deepLink: "/validation",
    });

    // Nouvel événement, fenêtre échue — mais la file n'a pas été ouverte
    // depuis le dernier envoi : PAS de re-notification.
    await recordPushEvent(orgA, [ownerId], "actions", 1, { now: afterWindow });
    const later = new Date(afterWindow.getTime() + WINDOW_MS + 60_000);
    expect(await flushTenantPushWindows(orgA, sender, later)).toBe(0);

    // L'utilisateur ouvre la file (GET /pending-actions marque « vu ») ;
    // un événement suivant re-notifie normalement.
    const seen = await app.inject({
      method: "GET",
      url: "/pending-actions",
      headers: { cookie: ownerCookie },
    });
    expect(seen.statusCode).toBe(200);
    await recordPushEvent(orgA, [ownerId], "actions", 1, { now: later });
    const t3 = new Date(later.getTime() + WINDOW_MS + 60_000);
    expect(await flushTenantPushWindows(orgA, sender, t3)).toBe(1);
    expect(sends[1]!.payload.count).toBe(1);
  });

  it("les alertes urgentes partent au sweep suivant (fenêtre 0) avec leur deep-link", async () => {
    await markPushSeen(orgA, ownerId, "alerts");
    const t0 = new Date(Date.now() - 30 * 60_000);
    await recordPushEvent(orgA, [ownerId], "alerts", 3, { now: t0, mode: "set" });
    const { sends, sender } = fakeSender();
    expect(await flushTenantPushWindows(orgA, sender, new Date(t0.getTime() + 1_000))).toBe(1);
    expect(sends[0]!.payload).toEqual({ type: "alerte_urgente", count: 3, deepLink: "/" });
  });

  it("opt-out d'un type : l'alerte ne part pas, les actions passent encore", async () => {
    // L'appareil restant de l'owner a alertsEnabled=false ? Non — on crée un
    // appareil dédié avec alertes coupées et on retire les autres.
    await withTenant(orgA, (tx) => tx.pushSubscription.deleteMany({ where: { userId: ownerId } }));
    await subscribe(ownerCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/owner-optout`, {
      alertsEnabled: false,
    });
    await markPushSeen(orgA, ownerId, "actions");
    await markPushSeen(orgA, ownerId, "alerts");

    const t0 = new Date(Date.now() - 60 * 60_000);
    await recordPushEvent(orgA, [ownerId], "alerts", 1, { now: t0, mode: "set" });
    await recordPushEvent(orgA, [ownerId], "actions", 1, { now: t0 });
    const { sends, sender } = fakeSender();
    await flushTenantPushWindows(orgA, sender, new Date(t0.getTime() + WINDOW_MS + 60_000));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.type).toBe("actions_en_attente");
  });

  it("endpoint mort (410) : la subscription est nettoyée", async () => {
    await withTenant(orgA, (tx) => tx.pushSubscription.deleteMany({ where: { userId: ownerId } }));
    const endpoint = `https://fcm.googleapis.com/fcm/send/${RUN}/owner-dead`;
    await subscribe(ownerCookie, endpoint);
    await markPushSeen(orgA, ownerId, "actions");
    const t0 = new Date(Date.now() - 40 * 60_000);
    await recordPushEvent(orgA, [ownerId], "actions", 1, { now: t0 });
    const { sender } = fakeSender({ [endpoint]: "gone" });
    await flushTenantPushWindows(orgA, sender, new Date(t0.getTime() + WINDOW_MS + 60_000));
    const remaining = await withTenant(orgA, (tx) =>
      tx.pushSubscription.findMany({ where: { userId: ownerId } }),
    );
    expect(remaining).toHaveLength(0);
  });
});

describe("isolation tenant", () => {
  it("les événements d'un tenant ne déclenchent jamais les appareils d'un autre", async () => {
    await subscribe(otherCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/other-1`);
    const t0 = new Date();
    // Événement pour le tenant A uniquement.
    await recordPushEvent(orgA, [ownerId], "actions", 1, { now: t0 });
    const { sends, sender } = fakeSender();
    const later = new Date(t0.getTime() + WINDOW_MS + 60_000);
    await flushTenantPushWindows(orgB, sender, later);
    expect(sends).toHaveLength(0);
    // Et l'état de dispatch du tenant B est vierge.
    const statesB = await withTenant(orgB, (tx) => tx.pushDispatchState.findMany());
    expect(statesB).toHaveLength(0);
  });

  it("un même appareil peut servir DEUX organisations (expert-comptable multi-tenants)", async () => {
    // Le même endpoint que celui du tenant B, enregistré depuis le tenant A :
    // accepté — l'unicité est par (tenant, endpoint), pas globale.
    const res = await subscribe(ownerCookie, `https://fcm.googleapis.com/fcm/send/${RUN}/other-1`);
    expect(res.statusCode).toBe(201);
    await app.inject({
      method: "DELETE",
      url: `/push/subscriptions/${res.body.id as string}`,
      headers: { cookie: ownerCookie },
    });
  });
});
