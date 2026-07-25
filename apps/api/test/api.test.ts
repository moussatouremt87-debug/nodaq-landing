import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let admin: PrismaClient;

/** Extrait les cookies d'une réponse inject() en un header Cookie réutilisable. */
function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

/** Inscrit un user (auto sign-in better-auth) et renvoie son cookie de session. */
async function signup(email: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "un-mot-de-passe-solide-123", name },
  });
  expect(res.statusCode).toBe(200);
  const cookie = cookiesOf(res);
  expect(cookie).toContain("better-auth");
  return cookie;
}

async function createTenant(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/tenants",
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  admin = createAdminClient();
  await admin.note.deleteMany();
  await admin.membership.deleteMany();
  await admin.session.deleteMany();
  await admin.account.deleteMany();
  await admin.user.deleteMany();
  await admin.tenant.deleteMany();
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("GET /health", () => {
  it("répond ok avec la base joignable", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });
});

describe("auth (better-auth) + tenant de session", () => {
  let cookieA: string;
  let cookieB: string;
  let tenantA: string;
  let tenantB: string;

  it("refuse les routes protégées sans session (401)", async () => {
    for (const [method, url] of [
      ["GET", "/notes"],
      ["POST", "/notes"],
      ["POST", "/tenants"],
      ["GET", "/me"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it("sign-up → session → création de tenant avec membership OWNER", async () => {
    cookieA = await signup("alice@exemple.fr", "Alice");
    tenantA = await createTenant(cookieA, "Tenant Alice");

    const me = await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieA } });
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships).toEqual([
      { tenantId: tenantA, role: "OWNER", tenant: { name: "Tenant Alice" } },
    ]);
  });

  it("sans tenant : /notes renvoie 403 avec invitation à créer un tenant", async () => {
    const cookie = await signup("sans-tenant@exemple.fr", "Sans Tenant");
    const res = await app.inject({ method: "GET", url: "/notes", headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("le tenant vient de la session : notes créées et lues sans header", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie: cookieA },
      payload: { title: "note d'Alice", body: "contenu A" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tenantId).toBe(tenantA);

    const list = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieA } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it("un autre user/tenant ne voit rien", async () => {
    cookieB = await signup("bob@exemple.fr", "Bob");
    tenantB = await createTenant(cookieB, "Tenant Bob");

    const list = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieB } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(0);
  });

  it("TEST CLÉ — le header x-tenant-id ne permet plus d'usurper un tenant (403)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: cookieB, "x-tenant-id": tenantA },
    });
    expect(res.statusCode).toBe(403);
  });

  it("x-tenant-id reste utilisable comme sélecteur parmi SES tenants", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: cookieB, "x-tenant-id": tenantB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  it("x-tenant-id malformé → 400 ; multi-tenant sans header → 400 avec la liste", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: cookieB, "x-tenant-id": "pas-un-uuid" },
    });
    expect(bad.statusCode).toBe(400);

    const secondTenant = await createTenant(cookieB, "Tenant Bob 2");
    const ambiguous = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: cookieB },
    });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().tenants).toHaveLength(2);

    const explicit = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: cookieB, "x-tenant-id": secondTenant },
    });
    expect(explicit.statusCode).toBe(200);
  });

  it("payload de note invalide → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie: cookieA },
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
