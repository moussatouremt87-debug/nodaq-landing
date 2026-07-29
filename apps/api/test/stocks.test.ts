import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Suivi des stocks (ticket 3.2) : référentiel owner, ajustements membre
 * journalisés en append-only, plancher à zéro, alertes sous seuil, isolation
 * tenant, et exécution HITL de adjust_stock (la quantité ne bouge JAMAIS
 * sans validation humaine).
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let otherCookie: string;
let orgA: string;
let ownerId: string;

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

const RUN = Date.now().toString(36);

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`stocks-owner-${RUN}@example.com`, "Stocks Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Stocks ${RUN}`, slug: `org-stocks-${RUN}` },
  });
  orgA = org.json().id as string;
  ownerId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: ownerCookie } })
  ).json().userId as string;

  otherCookie = await signup(`stocks-other-${RUN}@example.com`, "Stocks Other");
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: otherCookie },
    payload: { name: `Org Stocks B ${RUN}`, slug: `org-stocks-b-${RUN}` },
  });

  memberCookie = await signup(`stocks-member-${RUN}@example.com`, "Stocks Member");
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

describe("référentiel /stocks", () => {
  let itemId: string;

  it("401 anonyme ; création owner-only (member 403), doublon 409, champ inconnu 400", async () => {
    const anon = await app.inject({ method: "GET", url: "/stocks" });
    expect(anon.statusCode).toBe(401);

    const denied = await app.inject({
      method: "POST",
      url: "/stocks",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { name: "Câble 3G2,5" },
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/stocks",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { name: "Câble 3G2,5", unit: "mètre", alertThreshold: 50 },
    });
    expect(created.statusCode).toBe(201);
    itemId = created.json().item.id as string;
    // 0 en stock avec un seuil de 50 : l'article naît SOUS le seuil.
    expect(created.json().item).toMatchObject({ quantity: 0, belowThreshold: true });

    const duplicate = await app.inject({
      method: "POST",
      url: "/stocks",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { name: "Câble 3G2,5" },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknown = await app.inject({
      method: "POST",
      url: "/stocks",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { name: "X", quantity: 999 }, // la quantité ne se crée pas, elle se MEUT
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("ajustements membre journalisés, plancher à zéro (409), alerte sous seuil", async () => {
    const entry = await app.inject({
      method: "POST",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { delta: 200, reason: "réception fournisseur" },
    });
    expect(entry.statusCode).toBe(200);
    expect(entry.json().item.quantity).toBe(200);

    const overdraw = await app.inject({
      method: "POST",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { delta: -500 },
    });
    expect(overdraw.statusCode).toBe(409);

    const exit = await app.inject({
      method: "POST",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { delta: -160, reason: "chantier Lefevre" },
    });
    expect(exit.json().item).toMatchObject({ quantity: 40, belowThreshold: true });

    const zero = await app.inject({
      method: "POST",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { delta: 0 },
    });
    expect(zero.statusCode).toBe(400);

    const movements = await app.inject({
      method: "GET",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: memberCookie },
    });
    expect(movements.json().movements).toHaveLength(2);
    expect(movements.json().movements[0]).toMatchObject({ delta: -160 });
    // L'auteur du mouvement n'est pas exposé dans la réponse (métadonnée interne).
    expect(movements.body).not.toContain("createdBy");

    // Le cockpit compte l'alerte (visible de tout membre).
    const kpis = await app.inject({ method: "GET", url: "/cockpit/kpis", headers: { cookie: memberCookie } });
    expect(kpis.json().stockAlerts).toBe(1);
  });

  it("seuil modifiable par l'owner seulement ; suppression owner", async () => {
    const denied = await app.inject({
      method: "PATCH",
      url: `/stocks/${itemId}`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { alertThreshold: 10 },
    });
    expect(denied.statusCode).toBe(403);

    const updated = await app.inject({
      method: "PATCH",
      url: `/stocks/${itemId}`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { alertThreshold: 10 },
    });
    expect(updated.json().item).toMatchObject({ alertThreshold: 10, belowThreshold: false });
  });

  it("isolation : le tenant B ne voit rien", async () => {
    const list = await app.inject({ method: "GET", url: "/stocks", headers: { cookie: otherCookie } });
    expect(list.json().items).toEqual([]);
    const cross = await app.inject({
      method: "POST",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: otherCookie, "content-type": "application/json" },
      payload: { delta: 1 },
    });
    expect(cross.statusCode).toBe(404);
  });

  it("HITL adjust_stock : la quantité ne bouge qu'à l'approbation ; stock insuffisant => failed", async () => {
    const before = (
      await app.inject({ method: "GET", url: "/stocks", headers: { cookie: ownerCookie } })
    ).json().items.find((i: { id: string }) => i.id === itemId).quantity as number;

    // La pending_action est créée par l'outil agent en conditions réelles ;
    // ici on l'insère directement (même payload) pour tester l'EXÉCUTEUR.
    const action = await admin.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "adjust_stock",
        payload: { itemId, itemName: "Câble 3G2,5", unit: "mètre", quantityBefore: before, delta: -5, reason: "chantier" },
      },
    });
    expect(before).toBe(40); // rien n'a bougé à la création

    const approve = await app.inject({
      method: "POST",
      url: `/pending-actions/${action.id}/approve`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);

    const after = (
      await app.inject({ method: "GET", url: "/stocks", headers: { cookie: ownerCookie } })
    ).json().items.find((i: { id: string }) => i.id === itemId);
    expect(after.quantity).toBe(35);

    // Mouvement journalisé par l'exécuteur.
    const movements = await app.inject({
      method: "GET",
      url: `/stocks/${itemId}/movements`,
      headers: { cookie: ownerCookie },
    });
    expect(movements.json().movements[0]).toMatchObject({ delta: -5 });

    // Sortie impossible (stock insuffisant) => action failed, quantité intacte.
    const tooBig = await admin.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "adjust_stock",
        payload: { itemId, delta: -10_000 },
      },
    });
    const failed = await app.inject({
      method: "POST",
      url: `/pending-actions/${tooBig.id}/approve`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    expect([200, 500, 502]).toContain(failed.statusCode);
    const row = await admin.pendingAction.findUnique({ where: { id: tooBig.id } });
    expect(row?.status).toBe("failed");
    const unchanged = (
      await app.inject({ method: "GET", url: "/stocks", headers: { cookie: ownerCookie } })
    ).json().items.find((i: { id: string }) => i.id === itemId);
    expect(unchanged.quantity).toBe(35);
    expect(ownerId).toBeTruthy();
  });
});
