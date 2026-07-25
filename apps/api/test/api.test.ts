import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let admin: PrismaClient;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createAdminClient();
  await admin.note.deleteMany();
  await admin.tenant.deleteMany({ where: { name: { in: ["API Tenant A", "API Tenant B"] } } });
  tenantA = (await admin.tenant.create({ data: { name: "API Tenant A" } })).id;
  tenantB = (await admin.tenant.create({ data: { name: "API Tenant B" } })).id;
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

describe("/notes (scellé par tenant)", () => {
  it("refuse une requête sans x-tenant-id valide", async () => {
    const noHeader = await app.inject({ method: "GET", url: "/notes" });
    expect(noHeader.statusCode).toBe(400);
    const badHeader = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { "x-tenant-id": "pas-un-uuid" },
    });
    expect(badHeader.statusCode).toBe(400);
  });

  it("refuse un payload invalide", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { "x-tenant-id": tenantA },
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("crée puis liste les notes du tenant appelant, invisibles pour l'autre tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { "x-tenant-id": tenantA },
      payload: { title: "hello", body: "note du tenant A" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tenantId).toBe(tenantA);

    const listA = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { "x-tenant-id": tenantA },
    });
    expect(listA.statusCode).toBe(200);
    expect(listA.json()).toHaveLength(1);

    const listB = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { "x-tenant-id": tenantB },
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json()).toHaveLength(0);
  });
});
