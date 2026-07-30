import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Assistant RGPD (3.9) : registre des traitements (art. 30) = document de
 * conformité stratégique -> OWNER-ONLY de bout en bout ; modèles CNIL
 * versionnés sourcés ; audit déterministe (registre vide, durée manquante,
 * données sensibles) ; label « pas un conseil juridique ni un DPO ».
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

  ownerCookie = await signup(`rgpd-owner-${RUN}@example.com`, "Rgpd Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Rgpd ${RUN}`, slug: `org-rgpd-${RUN}` },
  });
  const orgA = org.json().id as string;

  memberCookie = await signup(`rgpd-member-${RUN}@example.com`, "Rgpd Member");
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

describe("assistant RGPD — owner-only", () => {
  it("un membre n'accède à RIEN : 403 partout", async () => {
    for (const [method, url] of [
      ["GET", "/rgpd"],
      ["POST", "/rgpd"],
      ["POST", "/rgpd/modele/paie"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(method === "POST" && url === "/rgpd"
          ? {
              payload: {
                name: "X",
                purpose: "test",
                legalBasis: "contrat",
                dataCategories: ["identite"],
                dataSubjects: ["clients"],
                retention: "1 an",
              },
            }
          : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("registre vide = alerte art. 30 ; ajout depuis modèle CNIL ; doublon = 409", async () => {
    const empty = await app.inject({
      method: "GET",
      url: "/rgpd",
      headers: { cookie: ownerCookie },
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = empty.json() as {
      activities: unknown[];
      audit: { issues: { code: string }[]; label: string; version: string };
      templates: { id: string; source: { url: string } }[];
    };
    expect(emptyBody.activities).toEqual([]);
    expect(emptyBody.audit.issues.some((i) => i.code === "registre_vide")).toBe(true);
    expect(emptyBody.audit.label).toContain("conseil juridique");
    expect(emptyBody.templates.length).toBeGreaterThanOrEqual(6);
    for (const template of emptyBody.templates) {
      expect(template.source.url).toMatch(/^https:\/\//);
    }

    const fromTemplate = await app.inject({
      method: "POST",
      url: "/rgpd/modele/paie",
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(fromTemplate.statusCode).toBe(201);
    // Même modèle deux fois : 409 net (unicité par nom), jamais un 500 ORM.
    const dup = await app.inject({
      method: "POST",
      url: "/rgpd/modele/paie",
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(dup.statusCode).toBe(409);
    const unknown = await app.inject({
      method: "POST",
      url: "/rgpd/modele/inexistant",
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("saisie, audit incohérences, correction, suppression", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/rgpd",
      headers: { cookie: ownerCookie },
      payload: {
        name: `Suivi médical ${RUN}`,
        purpose: "Suivi des visites médicales du personnel",
        legalBasis: "interet_legitime",
        dataCategories: ["identite", "sante"],
        dataSubjects: ["salaries"],
        retention: "",
      },
    });
    // retention vide refusée par Zod (min 1).
    expect(created.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/rgpd",
      headers: { cookie: ownerCookie },
      payload: {
        name: `Suivi médical ${RUN}`,
        purpose: "Suivi des visites médicales du personnel",
        legalBasis: "interet_legitime",
        dataCategories: ["identite", "sante"],
        dataSubjects: ["salaries"],
        retention: "5 ans",
        sensitiveData: true,
      },
    });
    expect(ok.statusCode).toBe(201);
    const activityId = (ok.json() as { id: string }).id;

    const audited = await app.inject({
      method: "GET",
      url: "/rgpd",
      headers: { cookie: ownerCookie },
    });
    const auditBody = audited.json() as { audit: { issues: { code: string }[] } };
    // Données sensibles sur intérêt légitime : alerte base_inadaptee.
    expect(auditBody.audit.issues.some((i) => i.code === "base_inadaptee")).toBe(true);

    const patched = await app.inject({
      method: "PATCH",
      url: `/rgpd/${activityId}`,
      headers: { cookie: ownerCookie },
      payload: { legalBasis: "obligation_legale" },
    });
    expect(patched.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/rgpd", headers: { cookie: ownerCookie } });
    const afterBody = after.json() as { audit: { issues: { code: string }[] } };
    expect(afterBody.audit.issues.some((i) => i.code === "base_inadaptee")).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/rgpd/${activityId}`,
      headers: { cookie: ownerCookie },
    });
    expect(deleted.statusCode).toBe(200);
  });
});
