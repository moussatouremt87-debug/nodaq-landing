import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { VERTICALS } from "@nodaq/shared";
import { buildApp } from "../src/app.js";

/*
 * Veille réglementaire (3.7) : profil stratégique (vertical + effectif RH)
 * -> OWNER-ONLY de bout en bout ; obligations depuis le catalogue versionné
 * sourcé via le MÊME outil owner-gated que l'agent ; label « information
 * générale, pas un conseil juridique » permanent.
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

  ownerCookie = await signup(`veille-owner-${RUN}@example.com`, "Veille Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Veille ${RUN}`, slug: `org-veille-${RUN}` },
  });
  const orgA = org.json().id as string;

  memberCookie = await signup(`veille-member-${RUN}@example.com`, "Veille Member");
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

describe("veille réglementaire — owner-only", () => {
  it("la liste VERTICALS (TS) et le CHECK SQL de tenant_profiles restent synchrones", () => {
    // Liste dupliquée base/TS : un vertical ajouté côté TS sans migration
    // donnerait un 500 (échec fermé, mais cassé). Ce test fige la synchro.
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/db/prisma/migrations/20260730000000_tenant_profiles/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const check = /tenant_profiles_vertical_check[\s\S]*?\(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const sqlValues = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlValues).toEqual([...VERTICALS].sort());
  });

  it("un membre n'accède à RIEN (profil, obligations) : 403 partout", async () => {
    for (const [method, url] of [
      ["GET", "/reglementaire"],
      ["GET", "/reglementaire/profil"],
      ["PUT", "/reglementaire/profil"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(method === "PUT" ? { payload: { vertical: "retail" } } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("profil par défaut honnête : vertical « autre », effectif inconnu (jamais 0 supposé)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      vertical: "autre",
      headcountOverride: null,
      derivedHeadcount: null,
    });
  });

  it("profil renseigné puis obligations : seuils, sources, tri par urgence, label", async () => {
    // Vertical inconnu ou champ en trop : refus net (strict).
    const bad = await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "banque" },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "industrie_btp", headcountOverride: 25 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ vertical: "industrie_btp", headcountOverride: 25 });

    const res = await app.inject({
      method: "GET",
      url: "/reglementaire",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: string;
      label: string;
      profile: { vertical: string; headcount: number | null; headcountSource: string };
      matches: {
        id: string;
        applies: string;
        status: string;
        reason: string;
        source: { label: string; url: string };
      }[];
    };
    expect(body.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.label).toContain("conseil juridique");
    expect(body.profile).toMatchObject({
      vertical: "industrie_btp",
      headcount: 25,
      headcountSource: "declare",
    });
    // 25 salariés en BTP : CSE (11) et OETH (20) applicables, index égalité (50) non.
    const ids = body.matches.map((m) => m.id);
    expect(ids).toContain("cse");
    expect(ids).toContain("oeth");
    expect(ids).toContain("garantie-decennale");
    expect(ids).not.toContain("index-egalite");
    // Chaque inclusion est justifiée et sourcée.
    for (const match of body.matches) {
      expect(match.reason.length).toBeGreaterThan(10);
      expect(match.source.url).toMatch(/^https:\/\//);
    }
  });
});
