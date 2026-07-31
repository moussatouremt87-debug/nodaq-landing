import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Connecteur Silae (3.10) : identifiants testés contre le fournisseur (faux
 * serveur) avant coffre, puis sync HUMAINE owner-only qui alimente équipe +
 * absences de façon IDEMPOTENTE (externalRef, adoption par nom, dédup
 * absences) — re-synchroniser ne duplique jamais, ne double jamais un
 * conflit en silence. Salaires/bulletins jamais lus (le client ne les
 * expose même pas).
 */

const GOOD = { apiKey: "sk-silae-12345", dossierId: "DOSSIER-42" };

const fakeSilae = createServer((req, res) => {
  const authorized =
    req.headers.authorization === `Bearer ${GOOD.apiKey}` &&
    req.headers["x-dossier-id"] === GOOD.dossierId;
  if (!authorized) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "unauthorized" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  const path = req.url ?? "";
  if (path.startsWith("/employees")) {
    res.end(
      JSON.stringify({
        items: [
          { id: "emp-1", first_name: "Karim", last_name: "Benali", weekly_hours: 35, active: true },
          { id: "emp-2", first_name: "Lucie", last_name: "Martin", weekly_hours: 39, active: true },
          "garbage-row",
        ],
        next_cursor: null,
      }),
    );
  } else if (path.startsWith("/absences")) {
    res.end(
      JSON.stringify({
        items: [
          {
            id: "abs-1",
            employee_id: "emp-1",
            type: "Congés payés",
            start_date: "2026-08-03",
            end_date: "2026-08-16",
          },
          {
            id: "abs-2",
            employee_id: "emp-inconnu",
            type: "maladie",
            start_date: "2026-08-01",
            end_date: "2026-08-02",
          },
        ],
        next_cursor: null,
      }),
    );
  } else {
    res.end("{}");
  }
});

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;
const vaultStore = new Map<string, string>();
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
  await new Promise<void>((resolve) => fakeSilae.listen(0, "127.0.0.1", resolve));
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
    agentContext: {
      silaeBaseUrl: `http://127.0.0.1:${(fakeSilae.address() as AddressInfo).port}`,
    },
  });
  await app.ready();

  ownerCookie = await signup(`silae-owner-${RUN}@example.com`, "Silae Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Silae ${RUN}`, slug: `org-silae-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`silae-member-${RUN}@example.com`, "Silae Member");
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
  fakeSilae.close();
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("connecteur Silae — onboarding et sync", () => {
  it("sans connecteur : sync = 409 explicite ; membre : 403 partout", async () => {
    const notConfigured = await app.inject({
      method: "POST",
      url: "/connectors/silae/sync",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    expect(notConfigured.statusCode).toBe(409);

    for (const [method, url] of [
      ["POST", "/connectors/silae/sync"],
      ["POST", "/connectors"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie, "content-type": "application/json" },
        payload:
          url === "/connectors" ? { type: "silae", credentials: GOOD } : {},
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("identifiants testés avant coffre : 422 si faux, 201 si bons, jamais renvoyés", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/connectors",
      headers: { cookie: ownerCookie },
      payload: { type: "silae", credentials: { apiKey: "sk-wrong-key", dossierId: "X" } },
    });
    expect(bad.statusCode).toBe(422);
    expect([...vaultStore.keys()].some((k) => k.includes("silae"))).toBe(false);

    const good = await app.inject({
      method: "POST",
      url: "/connectors",
      headers: { cookie: ownerCookie },
      payload: { type: "silae", credentials: GOOD },
    });
    expect(good.statusCode).toBe(201);
    expect(JSON.stringify(good.json())).not.toContain(GOOD.apiKey);
    expect([...vaultStore.keys()].some((k) => k.includes("silae"))).toBe(true);
  });

  it("sync idempotente : création, adoption par nom, dédup absences, re-run à zéro", async () => {
    // Fiche manuelle homonyme : la sync doit l'ADOPTER (externalRef posé),
    // jamais créer un doublon.
    await admin.staffMember.create({
      data: { tenantId: orgId, name: "Lucie Martin", weeklyHours: 35 },
    });

    const first = await app.inject({
      method: "POST",
      url: "/connectors/silae/sync",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      employeesCreated: 1, // Karim
      employeesUpdated: 1, // Lucie adoptée
      employeesSkipped: 0,
      absencesCreated: 1, // abs-1 ; abs-2 = salarié inconnu, ignorée
      absencesSkipped: 1,
      truncated: false,
    });

    const staff = await admin.staffMember.findMany({
      where: { tenantId: orgId },
      orderBy: { name: "asc" },
    });
    expect(staff).toHaveLength(2);
    const lucie = staff.find((m) => m.name === "Lucie Martin");
    expect(lucie?.externalRef).toBe("emp-2");
    expect(lucie?.weeklyHours).toBe(39); // mise à jour depuis Silae
    const karim = staff.find((m) => m.name === "Karim Benali");
    expect(karim?.externalRef).toBe("emp-1");

    // Type d'absence mappé sur le vocabulaire 3.5.
    const absences = await admin.staffAbsence.findMany({ where: { tenantId: orgId } });
    expect(absences).toHaveLength(1);
    expect(absences[0]?.type).toBe("conges");

    // Re-run : rien ne double, tout est « déjà vu ».
    const second = await app.inject({
      method: "POST",
      url: "/connectors/silae/sync",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    expect(second.json()).toMatchObject({
      employeesCreated: 0,
      employeesUpdated: 2,
      absencesCreated: 0,
      absencesSkipped: 2,
    });
    expect(await admin.staffMember.count({ where: { tenantId: orgId } })).toBe(2);
    expect(await admin.staffAbsence.count({ where: { tenantId: orgId } })).toBe(1);

    // L'absence importée porte son id source (réconciliation).
    const [imported] = await admin.staffAbsence.findMany({ where: { tenantId: orgId } });
    expect(imported?.externalRef).toBe("abs-1");
  });

  it("unicité par TENANT : le même externalRef peut exister chez un autre tenant", async () => {
    const other = await admin.tenant.create({ data: { name: `Org Silae B ${RUN}` } });
    // Même id Silae ET même nom que chez le tenant A : l'index composite
    // (tenant_id, external_ref) doit l'accepter — jamais un oracle inter-tenant.
    const created = await admin.staffMember.create({
      data: {
        tenantId: other.id,
        name: "Karim Benali",
        weeklyHours: 20,
        externalRef: "emp-1",
      },
      select: { id: true },
    });
    expect(created.id).toBeTruthy();
    const twins = await admin.staffMember.findMany({
      where: { externalRef: "emp-1", tenantId: { in: [orgId, other.id] } },
    });
    expect(twins).toHaveLength(2);
  });
});
