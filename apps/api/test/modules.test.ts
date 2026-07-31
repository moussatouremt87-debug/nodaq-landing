import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Modules par vertical (3.11) : état effectif = défauts du catalogue
 * versionné (vertical du profil 3.7) + surcharges explicites de l'owner.
 * Lecture pour tous les membres (la nav en dépend), bascule owner-only.
 * Surface produit, PAS une frontière de sécurité (documenté).
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;

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

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`mod-owner-${RUN}@example.com`, "Mod Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Mod ${RUN}`, slug: `org-mod-${RUN}` },
  });
  const orgA = org.json().id as string;

  memberCookie = await signup(`mod-member-${RUN}@example.com`, "Mod Member");
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

describe("modules par vertical", () => {
  it("lecture membre OK (fail-open sans profil : vertical « autre », tout actif)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/modules",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: string;
      vertical: string;
      modules: { id: string; active: boolean; source: string }[];
    };
    expect(body.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.vertical).toBe("autre");
    expect(body.modules.length).toBeGreaterThanOrEqual(6);
    expect(body.modules.every((m) => m.active)).toBe(true);
    // La liste d'outils internes ne traverse pas la frontière HTTP.
    expect(JSON.stringify(body)).not.toContain("check_stock_alerts");
  });

  it("bascule membre : 403 ; module inconnu : 404 ; payload invalide : 400", async () => {
    const forbidden = await app.inject({
      method: "PUT",
      url: "/modules/stocks",
      headers: { cookie: memberCookie },
      payload: { active: false },
    });
    expect(forbidden.statusCode).toBe(403);

    const unknown = await app.inject({
      method: "PUT",
      url: "/modules/inexistant",
      headers: { cookie: ownerCookie },
      payload: { active: false },
    });
    expect(unknown.statusCode).toBe(404);

    const bad = await app.inject({
      method: "PUT",
      url: "/modules/stocks",
      headers: { cookie: ownerCookie },
      payload: { active: "non" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("défauts du vertical services (stocks off) puis choix explicite de l'owner", async () => {
    // Le profil 3.7 pilote les défauts.
    const profile = await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "services" },
    });
    expect(profile.statusCode).toBe(200);

    const defaults = await app.inject({
      method: "GET",
      url: "/modules",
      headers: { cookie: ownerCookie },
    });
    const stocks = (defaults.json() as { modules: { id: string; active: boolean; source: string }[] }).modules.find(
      (m) => m.id === "stocks",
    );
    expect(stocks).toMatchObject({ active: false, source: "defaut_vertical" });

    // L'owner réactive : le choix l'emporte et il est PERSISTANT.
    const enable = await app.inject({
      method: "PUT",
      url: "/modules/stocks",
      headers: { cookie: ownerCookie },
      payload: { active: true },
    });
    expect(enable.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/modules",
      headers: { cookie: memberCookie },
    });
    const stocksAfter = (after.json() as { modules: { id: string; active: boolean; source: string }[] }).modules.find(
      (m) => m.id === "stocks",
    );
    expect(stocksAfter).toMatchObject({ active: true, source: "choix" });
    // Le reste du profil (vertical) n'a pas été écrasé par l'upsert.
    const kept = await app.inject({
      method: "GET",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
    });
    expect((kept.json() as { vertical: string }).vertical).toBe("services");
  });
});
