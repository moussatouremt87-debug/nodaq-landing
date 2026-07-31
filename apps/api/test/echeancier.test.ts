import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Échéancier fiscal & social (2.9). Le régime fiscal d'une entreprise et le
 * montant de ses impôts sont des données de dirigeant : owner-only partout.
 * Et le produit ne DEVINE rien — ni le régime, ni un montant.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;
const RUN = Date.now().toString(36);

interface Deadline {
  obligationId: string;
  dueDate: string;
  amountCents: number | null;
  status: string;
  dateIsApproximate: boolean;
  basis: string;
}
interface Schedule {
  deadlines: Deadline[];
  gaps: string[];
  plannedOutflowCents: number;
  unpricedCount: number;
  rulesVersion: string;
  label: string;
}

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

async function schedule(monthsAhead = 12): Promise<Schedule> {
  const res = await app.inject({
    method: "GET",
    url: `/echeancier?monthsAhead=${monthsAhead}`,
    headers: { cookie: ownerCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Schedule;
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`ech-owner-${RUN}@example.com`, "Ech Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Ech ${RUN}`, slug: `org-ech-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`ech-member-${RUN}@example.com`, "Ech Member");
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

describe("accès", () => {
  it("membre : 403 sur toute la surface de l'échéancier", async () => {
    for (const [method, url, payload] of [
      ["GET", "/echeancier", undefined],
      ["GET", "/echeancier/profil", undefined],
      ["PUT", "/echeancier/profil", { vatRegime: "franchise" }],
      ["PUT", "/echeancier/deadline", { obligationId: "cfe_solde" }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe("profil fiscal — rien n'est deviné", () => {
  it("profil vierge : régime inconnu, aucune paie, et les trous sont DITS", async () => {
    const profile = await app.inject({
      method: "GET",
      url: "/echeancier/profil",
      headers: { cookie: ownerCookie },
    });
    expect(profile.json()).toMatchObject({
      vatRegime: "inconnu",
      payrollPeriodicity: "aucune",
      fiscalYearEndMonth: 12,
    });

    const state = await schedule();
    expect(state.deadlines.some((d) => d.obligationId.startsWith("tva"))).toBe(false);
    expect(state.deadlines.some((d) => d.obligationId === "dsn_mensuelle")).toBe(false);
    expect(state.gaps.some((gap) => gap.includes("Régime de TVA non renseigné"))).toBe(true);
    expect(state.gaps.some((gap) => gap.includes("Aucune paie"))).toBe(true);
    // Le label « pas votre expert-comptable » est PERMANENT.
    expect(state.label).toContain("expert-comptable");
    expect(state.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("régime renseigné : les échéances correspondantes apparaissent", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/echeancier/profil",
      headers: { cookie: ownerCookie },
      payload: {
        vatRegime: "reel_normal_mensuel",
        corporateTaxLiable: true,
        fiscalYearEndMonth: 12,
        payrollPeriodicity: "mensuelle",
      },
    });
    expect(saved.statusCode).toBe(200);
    const state = await schedule();
    expect(state.deadlines.some((d) => d.obligationId === "tva_ca3")).toBe(true);
    expect(state.deadlines.some((d) => d.obligationId === "dsn_mensuelle")).toBe(true);
    // Une date qui dépend du SIREN ne se présente jamais comme certaine.
    const ca3 = state.deadlines.find((d) => d.obligationId === "tva_ca3");
    expect(ca3?.dateIsApproximate).toBe(true);
    expect(ca3?.basis.length).toBeGreaterThan(20);
  });

  it("régime invalide : 400, jamais une valeur silencieusement retombée", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/echeancier/profil",
      headers: { cookie: ownerCookie },
      payload: {
        vatRegime: "regime-imaginaire",
        corporateTaxLiable: true,
        fiscalYearEndMonth: 12,
        payrollPeriodicity: "mensuelle",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("montants — déclarés, jamais dérivés", () => {
  it("aucun montant tant que rien n'est saisi ; les non chiffrées sont COMPTÉES", async () => {
    const state = await schedule();
    expect(state.deadlines.every((d) => d.amountCents === null)).toBe(true);
    expect(state.plannedOutflowCents).toBe(0);
    expect(state.unpricedCount).toBe(state.deadlines.length);
  });

  it("un montant saisi pèse sur le prévisionnel ; « payé » l'en sort", async () => {
    const target = (await schedule()).deadlines.find((d) => d.obligationId === "cfe_solde");
    expect(target).toBeDefined();
    const put = await app.inject({
      method: "PUT",
      url: "/echeancier/deadline",
      headers: { cookie: ownerCookie },
      payload: {
        obligationId: "cfe_solde",
        dueDate: target?.dueDate,
        amountCents: 1_450_00,
        status: "prevu",
        note: null,
      },
    });
    expect(put.statusCode).toBe(200);
    expect((await schedule()).plannedOutflowCents).toBe(1_450_00);

    // Idempotent : la même échéance ne crée pas une seconde ligne.
    await app.inject({
      method: "PUT",
      url: "/echeancier/deadline",
      headers: { cookie: ownerCookie },
      payload: {
        obligationId: "cfe_solde",
        dueDate: target?.dueDate,
        amountCents: 1_450_00,
        status: "paye",
        note: "prélevée",
      },
    });
    expect(
      await admin.taxDeadline.count({ where: { tenantId: orgId, obligationId: "cfe_solde" } }),
    ).toBe(1);
    const after = await schedule();
    expect(after.plannedOutflowCents).toBe(0);
    expect(after.deadlines.find((d) => d.obligationId === "cfe_solde")?.status).toBe("paye");
  });

  it("obligation inconnue : 400 — pas de surcharge orpheline en base", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/echeancier/deadline",
      headers: { cookie: ownerCookie },
      payload: {
        obligationId: "taxe_imaginaire",
        dueDate: "2026-12-15",
        amountCents: 100,
        status: "prevu",
        note: null,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("réponse non mise en cache : montants d'impôts", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/echeancier",
      headers: { cookie: ownerCookie },
    });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
