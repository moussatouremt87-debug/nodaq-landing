import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * CRM & prospection (2.12) — premier ticket qui stocke les données de
 * personnes qui ne sont PAS clientes.
 *
 * Ce qui est testé ici n'est pas l'utilité commerciale mais la légitimité de
 * la détention : une fiche sans provenance n'entre pas, une opposition sort la
 * personne de tout et ne se défait pas par une porte dérobée, et la fiche d'un
 * tenant reste invisible depuis un autre.
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

async function createProspect(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => { id: string } }> {
  return app.inject({ method: "POST", url: "/prospects", headers: { cookie }, payload }) as never;
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`prospect-owner-${RUN}@example.com`, "Prospect Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Prospect ${RUN}`, slug: `org-prospect-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`prospect-member-${RUN}@example.com`, "Prospect Member");
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

describe("provenance — une fiche sans origine n'existe pas", () => {
  it("création sans `source` : 400", async () => {
    const res = await createProspect(memberCookie, { name: "Sans Origine" });
    expect(res.statusCode).toBe(400);
  });

  it("provenance hors catalogue (fichier acheté) : 400", async () => {
    const res = await createProspect(memberCookie, {
      name: "Fichier Acheté",
      source: "achat_fichier",
    });
    expect(res.statusCode).toBe(400);
  });

  it("prospecter est le métier des membres : création autorisée, provenance déclarée", async () => {
    const res = await createProspect(memberCookie, {
      name: `Mme Roussel ${RUN}`,
      company: "Roussel Bâtiment",
      email: "contact@roussel.example",
      source: "salon",
    });
    expect(res.statusCode).toBe(201);
    const stored = await admin.prospect.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(stored.source).toBe("salon");
    expect(stored.optedOut).toBe(false);
  });
});

describe("opposition (art. 21) — une sortie, pas un filtre", () => {
  it("s'opposer efface les coordonnées et vide les comptes rendus", async () => {
    const created = await createProspect(memberCookie, {
      name: `M. Opposé ${RUN}`,
      email: "oppose@example.com",
      phone: "0600000000",
      notes: "rencontré au salon, budget 20k",
      source: "salon",
    });
    const { id } = created.json();

    const journal = await app.inject({
      method: "POST",
      url: `/prospects/${id}/interactions`,
      headers: { cookie: memberCookie },
      payload: { kind: "appel", occurredAt: "2026-07-01", note: "a demandé un devis" },
    });
    expect(journal.statusCode).toBe(201);

    const opposition = await app.inject({
      method: "POST",
      url: `/prospects/${id}/opposition`,
      headers: { cookie: memberCookie },
    });
    expect(opposition.statusCode).toBe(200);

    const stored = await admin.prospect.findUniqueOrThrow({ where: { id } });
    expect(stored.optedOut).toBe(true);
    expect(stored.optedOutAt).not.toBeNull();
    // Ce qui n'a plus de finalité s'en va ; ce qui empêche de recontacter reste.
    expect(stored.email).toBeNull();
    expect(stored.phone).toBeNull();
    expect(stored.notes).toBeNull();
    const interactions = await admin.prospectInteraction.findMany({ where: { prospectId: id } });
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.note).toBeNull();
  });

  it("BLOQUANT corrigé : la personne opposée ne revient pas par une resaisie", async () => {
    // La fiche opposée était gardée AU MOTIF d'empêcher le réimport — mais
    // l'opposition efface l'e-mail, et la création ne consultait rien. La
    // liste d'exclusion (condensats) est ce qui tient réellement la garde.
    const email = `revient-${RUN}@example.com`;
    const created = await createProspect(memberCookie, {
      name: `Revenant ${RUN}`,
      email,
      source: "salon",
    });
    await app.inject({
      method: "POST",
      url: `/prospects/${created.json().id}/opposition`,
      headers: { cookie: memberCookie },
    });

    // Même adresse, écrite autrement : la normalisation doit la reconnaître.
    const again = await createProspect(memberCookie, {
      name: `Revenant bis ${RUN}`,
      email: `  ${email.toUpperCase()} `,
      source: "site_web",
    });
    expect(again.statusCode).toBe(409);

    // Et rattacher l'adresse à une AUTRE fiche par PATCH est fermé aussi.
    const other = await createProspect(memberCookie, {
      name: `Tiers ${RUN}`,
      source: "reseau_pro",
    });
    const patched = await app.inject({
      method: "PATCH",
      url: `/prospects/${other.json().id}`,
      headers: { cookie: memberCookie },
      payload: { email },
    });
    expect(patched.statusCode).toBe(409);
  });

  it("la liste d'exclusion ne porte aucune coordonnée en clair", async () => {
    const email = `hash-${RUN}@example.com`;
    const created = await createProspect(memberCookie, {
      name: `Hashé ${RUN}`,
      email,
      phone: "06 12 34 56 78",
      source: "salon",
    });
    await app.inject({
      method: "POST",
      url: `/prospects/${created.json().id}/opposition`,
      headers: { cookie: memberCookie },
    });
    const exclusions = await admin.prospectExclusion.findMany({ where: { tenantId: orgId } });
    expect(exclusions.length).toBeGreaterThanOrEqual(2);
    for (const exclusion of exclusions) {
      expect(exclusion.contactHash).toMatch(/^[0-9a-f]{64}$/);
      expect(exclusion.contactHash).not.toContain("@");
    }
    expect(JSON.stringify(exclusions)).not.toContain(email);
  });

  it("un PATCH ne peut pas remettre un e-mail sur une personne opposée : 409", async () => {
    const created = await createProspect(memberCookie, {
      name: `Patch Opposé ${RUN}`,
      source: "reseau_pro",
    });
    const { id } = created.json();
    await app.inject({
      method: "POST",
      url: `/prospects/${id}/opposition`,
      headers: { cookie: memberCookie },
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/prospects/${id}`,
      headers: { cookie: memberCookie },
      payload: { email: "retour@example.com" },
    });
    expect(patched.statusCode).toBe(409);
    const stored = await admin.prospect.findUniqueOrThrow({ where: { id } });
    expect(stored.email).toBeNull();
  });

  it("consigner un contact sur une personne opposée : refusé", async () => {
    const created = await createProspect(memberCookie, {
      name: `Contact Opposé ${RUN}`,
      source: "site_web",
    });
    const { id } = created.json();
    await app.inject({
      method: "POST",
      url: `/prospects/${id}/opposition`,
      headers: { cookie: memberCookie },
    });
    const res = await app.inject({
      method: "POST",
      url: `/prospects/${id}/interactions`,
      headers: { cookie: memberCookie },
      payload: { kind: "appel", occurredAt: "2026-07-20" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("l'opposé disparaît du plan de relance, même très en retard", async () => {
    const created = await createProspect(memberCookie, {
      name: `Jamais Relancé ${RUN}`,
      source: "salon",
    });
    const { id } = created.json();
    // Fiche ancienne : sans opposition elle serait en tête des relances.
    await admin.prospect.update({
      where: { id },
      data: { createdAt: new Date("2024-01-01") },
    });

    const before = await app.inject({
      method: "GET",
      url: "/prospection/suivi",
      headers: { cookie: memberCookie },
    });
    expect(before.statusCode).toBe(200);
    expect(JSON.stringify(before.json())).toContain(`Jamais Relancé ${RUN}`);

    await app.inject({
      method: "POST",
      url: `/prospects/${id}/opposition`,
      headers: { cookie: memberCookie },
    });
    const after = await app.inject({
      method: "GET",
      url: "/prospection/suivi",
      headers: { cookie: memberCookie },
    });
    const body = after.json() as { optedOutCount: number };
    expect(JSON.stringify(body)).not.toContain(`Jamais Relancé ${RUN}`);
    expect(body.optedOutCount).toBeGreaterThanOrEqual(1);
  });
});

describe("suivi de prospection", () => {
  it("relance = un délai écoulé, avec son seuil ; réponse jamais mise en cache", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/prospection/suivi",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json() as {
      rulesVersion: string;
      followups: { reason: string; thresholdDays: number | null }[];
      label: string;
    };
    expect(body.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const followup of body.followups) {
      expect(followup.thresholdDays).toBeGreaterThan(0);
      expect(followup.reason).toContain("seuil");
    }
    expect(body.label).toContain("opposé");
  });

  it("ni e-mail ni téléphone ne sortent du suivi", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/prospection/suivi",
      headers: { cookie: memberCookie },
    });
    // Décider qui relancer ne demande pas de savoir comment le joindre.
    expect(JSON.stringify(res.json())).not.toContain("@");
  });
});

describe("cloisonnement", () => {
  it("la fiche d'un autre tenant est invisible", async () => {
    const otherCookie = await signup(`prospect-autre-${RUN}@example.com`, "Prospect Autre");
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: otherCookie },
      payload: { name: `Org Prospect B ${RUN}`, slug: `org-prospect-b-${RUN}` },
    });
    const mine = await createProspect(memberCookie, {
      name: `Fiche Confidentielle ${RUN}`,
      source: "recommandation",
    });
    const { id } = mine.json();

    const list = await app.inject({
      method: "GET",
      url: "/prospects",
      headers: { cookie: otherCookie },
    });
    expect(JSON.stringify(list.json())).not.toContain(`Fiche Confidentielle ${RUN}`);

    // Et l'id direct ne donne rien de plus qu'un 404.
    const patched = await app.inject({
      method: "PATCH",
      url: `/prospects/${id}`,
      headers: { cookie: otherCookie },
      payload: { stage: "gagne" },
    });
    expect(patched.statusCode).toBe(404);
  });

  it("la suppression définitive est réservée au dirigeant", async () => {
    const created = await createProspect(memberCookie, {
      name: `À Supprimer ${RUN}`,
      source: "salon",
    });
    const { id } = created.json();

    const refused = await app.inject({
      method: "DELETE",
      url: `/prospects/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(refused.statusCode).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/prospects/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await admin.prospect.findUnique({ where: { id } })).toBeNull();
  });

  it("s'opposer retire de la file la relance encore en attente", async () => {
    // Le brouillon porte le nom de la personne : le laisser en file, c'est
    // garder — et pouvoir approuver — une prospection à laquelle elle vient
    // de s'opposer.
    const created = await createProspect(memberCookie, {
      name: `File Opposée ${RUN}`,
      source: "salon",
    });
    const { id } = created.json();
    const pending = await admin.pendingAction.create({
      data: {
        tenantId: orgId,
        type: "record_prospect_contact",
        payload: { prospect: { id, stage: "contacte" }, draft: `Bonjour File Opposée ${RUN}…` },
      },
    });

    await app.inject({
      method: "POST",
      url: `/prospects/${id}/opposition`,
      headers: { cookie: memberCookie },
    });

    const after = await admin.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe("rejected");
    expect(JSON.stringify(after.payload)).not.toContain(`File Opposée ${RUN}`);
  });

  it("l'effacement définitif emporte aussi le brouillon en file", async () => {
    const created = await createProspect(memberCookie, {
      name: `Effacé ${RUN}`,
      source: "salon",
    });
    const { id } = created.json();
    const pending = await admin.pendingAction.create({
      data: {
        tenantId: orgId,
        type: "record_prospect_contact",
        payload: { prospect: { id, stage: "nouveau" }, draft: `Bonjour Effacé ${RUN}…` },
      },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/prospects/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deleted.statusCode).toBe(200);
    const after = await admin.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(JSON.stringify(after.payload)).not.toContain(`Effacé ${RUN}`);
  });

  it("anonyme : 401 sur tout", async () => {
    for (const url of ["/prospects", "/prospection/suivi"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });
});
