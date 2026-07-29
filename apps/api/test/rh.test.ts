import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Plannings RH (3.5) : données RH = PII -> OWNER-ONLY de bout en bout ;
 * équipe + absences gérées par l'owner ; le plan capacité/charge passe par
 * le MÊME outil owner-gated que l'agent (une implémentation, deux
 * consommateurs), et reste honnête sans facturier (verdicts « inconnu »).
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

  ownerCookie = await signup(`rh-owner-${RUN}@example.com`, "RH Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org RH ${RUN}`, slug: `org-rh-${RUN}` },
  });
  const orgA = org.json().id as string;

  memberCookie = await signup(`rh-member-${RUN}@example.com`, "RH Member");
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

describe("plannings RH — owner-only", () => {
  it("un membre n'accède à RIEN (équipe, plan, écritures) : 403 partout", async () => {
    for (const [method, url] of [
      ["GET", "/rh"],
      ["GET", "/rh/plan"],
      ["POST", "/rh/staff"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(method === "POST" ? { payload: { name: "X" } } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("équipe + absences (owner) puis plan honnête : capacité calculée, verdict « inconnu » sans facturier", async () => {
    const karim = await app.inject({
      method: "POST",
      url: "/rh/staff",
      headers: { cookie: ownerCookie },
      payload: { name: `Karim ${RUN}`, role: "technicien", weeklyHours: 35 },
    });
    expect(karim.statusCode).toBe(201);
    const karimId = (karim.json() as { id: string }).id;

    // Doublon de nom : refus net.
    const dup = await app.inject({
      method: "POST",
      url: "/rh/staff",
      headers: { cookie: ownerCookie },
      payload: { name: `Karim ${RUN}` },
    });
    expect(dup.statusCode).toBe(409);

    const absence = await app.inject({
      method: "POST",
      url: "/rh/absences",
      headers: { cookie: ownerCookie },
      payload: {
        staffId: karimId,
        type: "conges",
        startDate: "2099-01-05",
        endDate: "2099-01-11",
      },
    });
    expect(absence.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/rh", headers: { cookie: ownerCookie } });
    const body = list.json() as { staff: { name: string }[]; absences: unknown[] };
    expect(body.staff.some((member) => member.name === `Karim ${RUN}`)).toBe(true);
    expect(body.absences).toHaveLength(1);

    const plan = await app.inject({
      method: "GET",
      url: "/rh/plan",
      headers: { cookie: ownerCookie },
    });
    expect(plan.statusCode).toBe(200);
    const planBody = plan.json() as {
      months: { capacityHours: number; verdict: string }[];
      activeStaff: number;
      label: string;
    };
    expect(planBody.activeStaff).toBe(1);
    expect(planBody.label).toContain("estimation");
    // 35 h x 4,348 = 152 h ; pas de connecteur facturier -> « inconnu »,
    // jamais une charge fabriquée.
    expect(planBody.months[0]).toMatchObject({ capacityHours: 152, verdict: "inconnu" });
  });
});
