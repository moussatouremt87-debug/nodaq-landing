import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Avis clients / e-réputation (3.8) : lecture pour tous les membres (avis
 * publics), écriture du registre owner-only, et la RÉPONSE à un avis passe
 * par la file de validation — l'exécuteur enregistre la réponse validée sur
 * l'avis, sans jamais écraser une réponse existante (idempotent). La
 * publication plateforme reste manuelle en V1.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgA: string;

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

  ownerCookie = await signup(`avis-owner-${RUN}@example.com`, "Avis Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Avis ${RUN}`, slug: `org-avis-${RUN}` },
  });
  orgA = org.json().id as string;

  memberCookie = await signup(`avis-member-${RUN}@example.com`, "Avis Member");
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

describe("avis clients — registre et synthèse", () => {
  it("lecture membre OK ; écriture membre 403 ; saisie owner validée", async () => {
    const memberRead = await app.inject({
      method: "GET",
      url: "/avis",
      headers: { cookie: memberCookie },
    });
    expect(memberRead.statusCode).toBe(200);

    const memberWrite = await app.inject({
      method: "POST",
      url: "/avis",
      headers: { cookie: memberCookie },
      payload: { rating: 5, text: "super", reviewedAt: "2026-07-01" },
    });
    expect(memberWrite.statusCode).toBe(403);

    // Note hors bornes : refus net (Zod + CHECK en base).
    const badRating = await app.inject({
      method: "POST",
      url: "/avis",
      headers: { cookie: ownerCookie },
      payload: { rating: 9, text: "??", reviewedAt: "2026-07-01" },
    });
    expect(badRating.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/avis",
      headers: { cookie: ownerCookie },
      payload: {
        authorName: "Jean D.",
        rating: 2,
        text: "Intervention en retard, dommage.",
        reviewedAt: "2026-07-25",
      },
    });
    expect(created.statusCode).toBe(201);
  });

  it("import borné et idempotent par (source, externalId) ; synthèse via l'outil", async () => {
    const payload = {
      reviews: [
        {
          source: "google",
          externalId: `g-${RUN}-1`,
          authorName: "Marie",
          rating: 5,
          text: "Équipe au top, chantier propre.",
          reviewedAt: "2026-06-10",
        },
        {
          source: "google",
          externalId: `g-${RUN}-2`,
          rating: 4,
          text: "Bon travail.",
          reviewedAt: "2026-07-02",
        },
      ],
    };
    const first = await app.inject({
      method: "POST",
      url: "/avis/import",
      headers: { cookie: ownerCookie },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: 2, skipped: 0 });

    // Re-import du même export : rien ne double.
    const second = await app.inject({
      method: "POST",
      url: "/avis/import",
      headers: { cookie: ownerCookie },
      payload,
    });
    expect(second.json()).toMatchObject({ imported: 0, skipped: 2 });

    const reputation = await app.inject({
      method: "GET",
      url: "/avis/reputation",
      headers: { cookie: memberCookie },
    });
    expect(reputation.statusCode).toBe(200);
    const body = reputation.json() as {
      totalReviews: number;
      unansweredNegative: { id: string }[];
      label: string;
    };
    expect(body.totalReviews).toBeGreaterThanOrEqual(3);
    expect(body.label).toContain("avis enregistrés");
    // L'avis 2/5 récent sans réponse remonte en alerte — par id, sans PII.
    expect(JSON.stringify(body)).not.toContain("Jean D.");
  });

  it("exécuteur record_review_reply : réponse enregistrée après validation, jamais écrasée", async () => {
    const review = await admin.customerReview.create({
      data: {
        tenantId: orgA,
        rating: 1,
        text: "Très déçu.",
        reviewedAt: new Date("2026-07-20T00:00:00Z"),
      },
      select: { id: true },
    });

    const action = await admin.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "record_review_reply",
        payload: {
          review: { id: review.id, rating: 1, source: "manuel" },
          draft: "Merci pour votre retour, nous sommes navrés…",
        },
      },
    });
    const approve = await app.inject({
      method: "POST",
      url: `/pending-actions/${action.id}/approve`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);

    const stored = await admin.customerReview.findUnique({ where: { id: review.id } });
    expect(stored?.replyText).toContain("navrés");
    expect(stored?.repliedAt).not.toBeNull();

    // Une seconde proposition validée sur le MÊME avis ne réécrit rien.
    const again = await admin.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "record_review_reply",
        payload: { review: { id: review.id }, draft: "Autre texte" },
      },
    });
    await app.inject({
      method: "POST",
      url: `/pending-actions/${again.id}/approve`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    const unchanged = await admin.customerReview.findUnique({ where: { id: review.id } });
    expect(unchanged?.replyText).toContain("navrés");
  });

  it("saisie en doublon (source, externalId) : 409 net, jamais un 500 ORM", async () => {
    const payload = {
      source: "google",
      externalId: `dup-${RUN}`,
      rating: 4,
      text: "Très bien.",
      reviewedAt: "2026-07-10",
    };
    const first = await app.inject({
      method: "POST",
      url: "/avis",
      headers: { cookie: ownerCookie },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/avis",
      headers: { cookie: ownerCookie },
      payload,
    });
    expect(dup.statusCode).toBe(409);
    expect(JSON.stringify(dup.json())).not.toContain("Prisma");
  });

  it("payload forgé cross-tenant : l'avis d'un AUTRE tenant est invisible => failed, rien ne bouge", async () => {
    const other = await admin.tenant.create({ data: { name: `Avis Autre ${RUN}` } });
    const foreign = await admin.customerReview.create({
      data: {
        tenantId: other.id,
        rating: 1,
        text: "Avis d'un autre tenant.",
        reviewedAt: new Date("2026-07-01T00:00:00Z"),
      },
      select: { id: true },
    });
    const forged = await admin.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "record_review_reply",
        payload: { review: { id: foreign.id }, draft: "Tentative cross-tenant" },
      },
    });
    await app.inject({
      method: "POST",
      url: `/pending-actions/${forged.id}/approve`,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {},
    });
    const row = await admin.pendingAction.findUnique({ where: { id: forged.id } });
    expect(row?.status).toBe("failed");
    const untouched = await admin.customerReview.findUnique({ where: { id: foreign.id } });
    expect(untouched?.replyText).toBeNull();
  });
});
