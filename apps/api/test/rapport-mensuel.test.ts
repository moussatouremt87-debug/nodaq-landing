import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Rapport mensuel + anomalies (2.11) — premier ticket qui SYNTHÉTISE.
 *
 * Ce qui est testé côté API : le rapport est OWNER-ONLY (CA, encours échu,
 * nom du premier client), un mois en cours est REFUSÉ avec un motif plutôt
 * que produit sur trois semaines, et les anomalies remontées portent toutes
 * leurs chiffres — le front n'a rien à compléter, le modèle rien à inventer.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;

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

/** Mois précédent (UTC) — le dernier mois COMPLET, défaut de la route. */
function lastCompleteMonth(): string {
  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`rapport-owner-${RUN}@example.com`, "Rapport Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Rapport ${RUN}`, slug: `org-rapport-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`rapport-member-${RUN}@example.com`, "Rapport Member");
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

  // Facturier démo : 12 mois d'historique payé, zéro réseau.
  await withTenant(orgId, (tx) =>
    tx.connector.upsert({
      where: { tenantId_type: { tenantId: orgId, type: "pennylane" } },
      update: { status: "demo" },
      create: {
        tenantId: orgId,
        type: "pennylane",
        status: "demo",
        credentialsRef: `connector/${orgId}/pennylane`,
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("rapport mensuel — owner-only", () => {
  it("un membre n'y accède pas : 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rapports/mensuel",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("anonyme : 401", async () => {
    const res = await app.inject({ method: "GET", url: "/rapports/mensuel" });
    expect(res.statusCode).toBe(401);
  });
});

describe("ce que le rapport dit — et ce qu'il refuse", () => {
  it("défaut = dernier mois COMPLET, chiffres et seuils portés", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rapports/mensuel",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json() as {
      month: string;
      rulesVersion: string;
      revenueCents: number;
      referenceRevenueCents: number | null;
      anomalies: { reason: string; threshold: number; sampleSize: number; observed: number }[];
      notEvaluated: string[];
      label: string;
    };
    expect(body.month).toBe(lastCompleteMonth());
    expect(body.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 12 mois de fixtures : la référence est calculable, jamais devinée.
    expect(body.referenceRevenueCents).not.toBeNull();
    // Chaque anomalie est un ÉCART MESURÉ : valeur, seuil, échantillon.
    for (const anomaly of body.anomalies) {
      expect(anomaly.threshold).toBeGreaterThan(0);
      expect(anomaly.sampleSize).toBeGreaterThan(0);
      expect(anomaly.reason.length).toBeGreaterThan(30);
    }
    expect(body.label).toContain("pas un jugement");
  });

  it("mois EN COURS : refus motivé, pas un rapport sur trois semaines", async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const res = await app.inject({
      method: "GET",
      url: `/rapports/mensuel?month=${current}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { refused?: boolean; reason?: string };
    expect(body.refused).toBe(true);
    expect(body.reason).toContain("pas terminé");
  });

  it("mois hors fenêtre de lecture : refus motivé, jamais un rapport vide", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rapports/mensuel?month=2015-03",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { refused?: boolean; reason?: string };
    expect(body.refused).toBe(true);
    expect(body.reason).toContain("fenêtre de lecture");
  });

  it("mois malformé : 400 net", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rapports/mensuel?month=mars-2026",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sans facturier, le rapport n'est pas fabriqué : 503", async () => {
    const otherCookie = await signup(`rapport-autre-${RUN}@example.com`, "Rapport Autre");
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: otherCookie },
      payload: { name: `Org Rapport B ${RUN}`, slug: `org-rapport-b-${RUN}` },
    });
    const res = await app.inject({
      method: "GET",
      url: "/rapports/mensuel",
      headers: { cookie: otherCookie },
    });
    // Aucun chiffre inventé, aucun « 0 € » présenté comme un constat.
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).not.toContain("revenueCents");
  });
});
