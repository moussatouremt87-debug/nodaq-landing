import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Affaires (ticket 4.1) — l'API du pivot du produit.
 *
 * Les deux règles qui commandent tout : un rattachement est TOUJOURS facultatif,
 * et une affaire ne se supprime JAMAIS. Le reste tient à la question que le
 * patron pose vraiment : « est-ce que CE chantier me rapporte de l'argent ? » —
 * à laquelle « 100 % de marge » est une réponse fausse et flatteuse.
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

async function createAffaire(payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/affaires",
    headers: { cookie: ownerCookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`aff-owner-${RUN}@example.com`, "Aff Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Aff ${RUN}`, slug: `org-aff-${RUN}` },
  });
  orgA = org.json().id as string;

  memberCookie = await signup(`aff-member-${RUN}@example.com`, "Aff Member");
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

describe("création et référence", () => {
  it("une affaire naît avec un simple libellé, et reçoit une référence de l'année", async () => {
    // Elle naît souvent d'un coup de fil : exiger le client, le montant ou les
    // dates à la création, c'est empêcher de s'en servir au moment utile.
    const res = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: ownerCookie },
      payload: { label: "Rénovation salle de bain" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toMatch(/^\d{4}-\d{3}$/);
    expect(body.status).toBe("PROSPECT");
    expect(body.clientName).toBeNull();
    expect(body.quotedAmountCents).toBeNull();
  });

  it("un membre ne crée pas d'affaire (403), mais il en lit la liste", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: memberCookie },
      payload: { label: "Tentative" },
    });
    expect(forbidden.statusCode).toBe(403);

    const list = await app.inject({
      method: "GET",
      url: "/affaires",
      headers: { cookie: memberCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().affaires.length).toBeGreaterThan(0);
  });

  it("un membre voit les chantiers SANS les montants", async () => {
    await createAffaire({ label: "Avec montant", quotedAmountCents: 500_000 });
    const asMember = await app.inject({
      method: "GET",
      url: "/affaires",
      headers: { cookie: memberCookie },
    });
    const body = asMember.json();
    expect(body.amountsVisible).toBe(false);
    expect(body.affaires.every((a: { quotedAmountCents: number | null }) => a.quotedAmountCents === null)).toBe(true);

    const asOwner = await app.inject({
      method: "GET",
      url: "/affaires",
      headers: { cookie: ownerCookie },
    });
    expect(asOwner.json().amountsVisible).toBe(true);
    expect(
      asOwner.json().affaires.some((a: { quotedAmountCents: number | null }) => a.quotedAmountCents === 500_000),
    ).toBe(true);
  });
});

describe("marge — jamais un chiffre flatteur", () => {
  it("une affaire vide affiche « données insuffisantes », pas 100 % de marge", async () => {
    const id = await createAffaire({ label: "Vide", quotedAmountCents: 1_200_000 });
    const res = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const marge = res.json().marge;
    expect(marge.kind).toBe("donnees_insuffisantes");
    expect(marge.marginCents).toBeUndefined();
    expect(marge.missing).toContain("couts");
  });

  it("trois achats imputés : les coûts s'additionnent, la marge reste une BORNE tant que le coût horaire manque", async () => {
    const id = await createAffaire({
      label: "Cuisine complète",
      clientName: "Mme Martin",
      status: "EN_COURS",
      quotedAmountCents: 1_200_000,
      hoursWorked: 40,
    });
    for (const [index, amount] of [200_000, 90_000, 60_000].entries()) {
      const res = await app.inject({
        method: "POST",
        url: `/affaires/${id}/imputations`,
        headers: { cookie: ownerCookie },
        payload: {
          targetType: "transaction_bancaire",
          targetId: `tx-cuisine-${RUN}-${index}`,
          amountCents: amount,
          amountBasis: "ht",
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    const body = fiche.json();
    expect(body.imputations).toHaveLength(3);
    expect(body.marge.materialCents).toBe(350_000);
    // Le coût horaire du tenant n'est pas saisi : compter zéro heure de travail
    // gonflerait la marge, donc on annonce un PLAFOND et on dit pourquoi.
    expect(body.marge.kind).toBe("marge_borne_superieure");
    expect(body.marge.missing).toContain("cout_horaire");
    expect(body.hourlyCostKnown).toBe(false);

    // Coût horaire renseigné => marge exacte : 1 200 000 − 350 000 − 40×3 500.
    await withTenant(orgA, (tx) =>
      tx.tenantProfile.upsert({
        where: { tenantId: orgA },
        create: { tenantId: orgA, hourlyCostCents: 3_500 },
        update: { hourlyCostCents: 3_500 },
      }),
    );
    const exact = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(exact.json().marge.kind).toBe("marge");
    expect(exact.json().marge.marginCents).toBe(710_000);
  });

  it("la marge est REFUSÉE à un membre, avec un motif — jamais un zéro muet", async () => {
    const id = await createAffaire({ label: "Confidentielle", quotedAmountCents: 800_000 });
    const res = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().marge).toBeNull();
    expect(res.json().margeRefus).toContain("dirigeant");
  });
});

describe("imputation rétroactive", () => {
  it("un document du classeur DÉJÀ classé se rattache après coup, et se détache", async () => {
    const document = await withTenant(orgA, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgA,
          fileName: "carrelage.jpg",
          mimeType: "image/jpeg",
          byteSize: 12,
          sha256: `sha-carrelage-${RUN}`,
          photo: Buffer.from("photo"),
          docType: "facture_fournisseur",
        },
      }),
    );
    expect(document.affaireId).toBeNull();

    const id = await createAffaire({ label: "Terrasse" });
    // C'est l'employé de terrain qui rattache : un membre DOIT pouvoir le faire.
    const imputed = await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: memberCookie },
      payload: {
        targetType: "classeur_document",
        targetId: document.id,
        amountCents: 45_000,
        amountBasis: "ht",
      },
    });
    expect(imputed.statusCode).toBe(201);

    const linked = await withTenant(orgA, (tx) =>
      tx.classeurDocument.findUnique({ where: { id: document.id } }),
    );
    expect(linked?.affaireId).toBe(id);

    const removed = await app.inject({
      method: "DELETE",
      url: `/affaires/${id}/imputations/${imputed.json().id}`,
      headers: { cookie: memberCookie },
    });
    expect(removed.statusCode).toBe(200);

    const detached = await withTenant(orgA, (tx) =>
      tx.classeurDocument.findUnique({ where: { id: document.id } }),
    );
    expect(detached?.affaireId).toBeNull();
    // La trace RESTE : c'est elle qui expliquera un chiffre a posteriori.
    const trace = await withTenant(orgA, (tx) =>
      tx.affaireImputation.findMany({ where: { affaireId: id } }),
    );
    expect(trace).toHaveLength(1);
    expect(trace[0]?.revokedAt).not.toBeNull();
  });

  it("une pièce déjà imputée ailleurs est REFUSÉE (409), pas comptée deux fois", async () => {
    const first = await createAffaire({ label: "Chantier A" });
    const second = await createAffaire({ label: "Chantier B" });
    const targetId = `tx-partage-${RUN}`;

    const ok = await app.inject({
      method: "POST",
      url: `/affaires/${first}/imputations`,
      headers: { cookie: ownerCookie },
      payload: { targetType: "transaction_bancaire", targetId, amountCents: 10_000, amountBasis: "ht" },
    });
    expect(ok.statusCode).toBe(201);

    const conflict = await app.inject({
      method: "POST",
      url: `/affaires/${second}/imputations`,
      headers: { cookie: ownerCookie },
      payload: { targetType: "transaction_bancaire", targetId, amountCents: 10_000, amountBasis: "ht" },
    });
    // Deux chantiers qui portent la même dépense, ce sont deux marges fausses.
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().affaireId).toBe(first);
  });

  it("un montant sans base HT/TTC est refusé (400)", async () => {
    const id = await createAffaire({ label: "Base manquante" });
    const res = await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: ownerCookie },
      payload: { targetType: "charge", targetId: `charge-${RUN}`, amountCents: 5_000 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("archivage", () => {
  it("aucune route de suppression n'existe", async () => {
    const id = await createAffaire({ label: "À ne pas supprimer" });
    const res = await app.inject({
      method: "DELETE",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    // Des pièces comptables y sont rattachées : la suppression n'est pas une
    // fonctionnalité manquante, c'est une fonctionnalité refusée.
    expect(res.statusCode).toBe(404);
  });

  it("archiver sort l'affaire des listes SANS rien détacher", async () => {
    const id = await createAffaire({ label: "Ancien chantier" });
    await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-archive-${RUN}`,
        amountCents: 30_000,
        amountBasis: "ht",
      },
    });

    const archived = await app.inject({
      method: "POST",
      url: `/affaires/${id}/archiver`,
      headers: { cookie: ownerCookie },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("ARCHIVEE");

    const list = await app.inject({ method: "GET", url: "/affaires", headers: { cookie: ownerCookie } });
    expect(list.json().affaires.some((a: { id: string }) => a.id === id)).toBe(false);

    const withArchived = await app.inject({
      method: "GET",
      url: "/affaires?inclureArchivees=true",
      headers: { cookie: ownerCookie },
    });
    expect(withArchived.json().affaires.some((a: { id: string }) => a.id === id)).toBe(true);

    // La fiche reste consultable, et ses pièces sont toujours là.
    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(fiche.json().imputations).toHaveLength(1);
  });
});

describe("retenue de garantie", () => {
  it("elle est EXCLUE du reste à facturer et exposée à part", async () => {
    // Relancer un client sur sa retenue contractuelle est la faute qui coûte
    // un client — le reste à facturer ne doit jamais la contenir.
    const id = await createAffaire({
      label: "Avec retenue",
      quotedAmountCents: 1_000_000,
      retentionRateBps: 500,
      hoursWorked: 0,
    });
    await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-retenue-${RUN}`,
        amountCents: 400_000,
        amountBasis: "ht",
      },
    });

    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    const marge = fiche.json().marge;
    expect(marge.retentionCents).toBe(50_000);
    expect(marge.remainingToInvoiceCents).toBe(950_000);
  });
});
