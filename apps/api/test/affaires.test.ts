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

describe("gardes de la revue — un coût ne s'invente pas", () => {
  it("un montant NÉGATIF est refusé (400) : pas de marge supérieure au devis", async () => {
    // Le trou trouvé en revue : sans borne, un membre pouvait poster
    // −5 000 € et faire afficher au dirigeant une marge plus grande que son
    // devis, présentée comme EXACTE.
    const id = await createAffaire({ label: "Anti-avoir", quotedAmountCents: 1_000_000 });
    const res = await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: memberCookie },
      payload: {
        targetType: "charge",
        targetId: `negatif-${RUN}`,
        amountCents: -500_000,
        amountBasis: "ht",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("une pièce INEXISTANTE est refusée (404), pas acceptée avec un montant fourni", async () => {
    // Avant : 201, et un coût fabriqué entrait dans la marge du dirigeant sur
    // une pièce qui n'a jamais existé.
    const id = await createAffaire({ label: "Cible fantôme" });
    const res = await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "classeur_document",
        targetId: "00000000-0000-4000-8000-000000000000",
        amountCents: 999_000,
        amountBasis: "ht",
      },
    });
    expect(res.statusCode).toBe(404);

    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(fiche.json().imputations).toHaveLength(0);
    expect(fiche.json().marge.kind).toBe("donnees_insuffisantes");
  });

  it("un prospect d'un autre tenant est refusé (404)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: ownerCookie },
      payload: { label: "Prospect étranger", prospectId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("effacer une pièce du classeur RÉVOQUE son imputation", async () => {
    // Sinon la fiche continue d'afficher un coût pour une pièce disparue, que
    // plus personne ne peut vérifier (art. 17 + « ce qui n'est pas calculé est dit »).
    const document = await withTenant(orgA, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgA,
          fileName: "a-effacer.jpg",
          mimeType: "image/jpeg",
          byteSize: 12,
          sha256: `sha-efface-${RUN}`,
          photo: Buffer.from("photo"),
          docType: "facture_fournisseur",
        },
      }),
    );
    const id = await createAffaire({ label: "Effacement", quotedAmountCents: 500_000 });
    await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "classeur_document",
        targetId: document.id,
        amountCents: 45_000,
        amountBasis: "ht",
      },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${document.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deleted.statusCode).toBe(204);

    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(fiche.json().imputations).toHaveLength(0);
  });

  it("le reste à facturer n'est PAS calculé quand le facturé est en TTC", async () => {
    // Le facturé vient des débits du compte 411 (TTC), le devis est en HT :
    // les soustraire ferait arrêter de facturer trop tôt.
    const id = await createAffaire({
      label: "Bases différentes",
      quotedAmountCents: 1_000_000,
      hoursWorked: 0,
    });
    // Une dépense, sinon le calcul s'arrête à « données insuffisantes » avant
    // même d'arriver au reste à facturer.
    await app.inject({
      method: "POST",
      url: `/affaires/${id}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-bases-${RUN}`,
        amountCents: 100_000,
        amountBasis: "ht",
      },
    });
    const fecImport = await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-bases-${RUN}`,
          entryCount: 1,
          customerCount: 1,
          invoiceCount: 1,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    await withTenant(orgA, (tx) =>
      tx.fecInvoice.create({
        data: {
          tenantId: orgA,
          importId: fecImport.id,
          customerRef: "411X",
          number: `F-${RUN}`,
          issuedDate: new Date("2026-06-01"),
          dueDate: new Date("2026-07-01"),
          amountCents: 600_000n,
          residualCents: 0n,
          settled: true,
          affaireId: id,
        },
      }),
    );

    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
    });
    const marge = fiche.json().marge;
    expect(marge.remainingToInvoiceCents).toBeNull();
    expect(marge.missing).toContain("facture_base_ttc");
  });
});

describe("F2 — photo → suggestion d'imputation", () => {
  async function newDocument(supplierName: string, docDate: string, sha: string) {
    return withTenant(orgA, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgA,
          fileName: `${sha}.jpg`,
          mimeType: "image/jpeg",
          byteSize: 12,
          sha256: sha,
          photo: Buffer.from("photo"),
          docType: "facture_fournisseur",
          extraction: { supplierName, docDate, totalInclTax: 120 },
        },
      }),
    );
  }

  it("apprend du tenant : le fournisseur déjà rattaché ici est proposé, avec ses preuves", async () => {
    const chantier = await createAffaire({
      label: "Suggestion A",
      status: "EN_COURS",
      startDate: "2026-05-01",
      plannedEndDate: "2026-07-31",
    });
    const autre = await createAffaire({
      label: "Suggestion B",
      status: "EN_COURS",
      startDate: "2026-05-01",
      plannedEndDate: "2026-07-31",
    });

    const past = await newDocument("Point P", "2026-06-01", `sha-f2-past-${RUN}`);
    const imputed = await app.inject({
      method: "POST",
      url: `/affaires/${chantier}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "classeur_document",
        targetId: past.id,
        amountCents: 12_000,
        amountBasis: "ttc",
      },
    });
    expect(imputed.statusCode).toBe(201);

    const fresh = await newDocument("POINT P", "2026-06-20", `sha-f2-new-${RUN}`);
    const res = await app.inject({
      method: "GET",
      url: `/classeur/documents/${fresh.id}/affaires-suggerees`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("suggestions");
    expect(body.items[0].affaireId).toBe(chantier);
    expect(body.items[0].reasons).toContainEqual({ kind: "historique_fournisseur", count: 1 });
    expect(autre).toBeDefined();
  });

  it("ne CRÉE aucune imputation : suggérer n'est pas écrire", async () => {
    // Une imputation posée d'office entrerait dans la marge sans validation.
    const chantier = await createAffaire({ label: "Sans écriture", status: "EN_COURS" });
    const document = await newDocument("Brico Dépôt", "2026-06-05", `sha-f2-dry-${RUN}`);
    await app.inject({
      method: "GET",
      url: `/classeur/documents/${document.id}/affaires-suggerees`,
      headers: { cookie: ownerCookie },
    });
    const imputations = await withTenant(orgA, (tx) =>
      tx.affaireImputation.findMany({ where: { affaireId: chantier } }),
    );
    expect(imputations).toHaveLength(0);
    const stillFree = await withTenant(orgA, (tx) =>
      tx.classeurDocument.findUnique({ where: { id: document.id } }),
    );
    expect(stillFree?.affaireId).toBeNull();
  });

  it("une pièce déjà rattachée ne se fait pas re-suggérer ailleurs", async () => {
    const chantier = await createAffaire({ label: "Déjà rattachée", status: "EN_COURS" });
    const document = await newDocument("Leroy", "2026-06-05", `sha-f2-done-${RUN}`);
    await app.inject({
      method: "POST",
      url: `/affaires/${chantier}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "classeur_document",
        targetId: document.id,
        amountCents: 5_000,
        amountBasis: "ttc",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/classeur/documents/${document.id}/affaires-suggerees`,
      headers: { cookie: ownerCookie },
    });
    expect(res.json().kind).toBe("abstention");
    expect(res.json().why).toBe("deja_rattachee");
  });

  it("la mémoire d'un tenant NE SORT PAS de son tenant", async () => {
    // Le coeur du ticket : « dérivée à la lecture, jamais partagée ». La RLS
    // l'assure, mais sans ce test on ne le saurait qu'en production.
    const otherOwner = await signup(`aff-b-${RUN}@example.com`, "Autre Patron");
    const otherOrg = await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: otherOwner },
      payload: { name: `Org B ${RUN}`, slug: `org-b-${RUN}` },
    });
    const orgB = otherOrg.json().id as string;

    // Chez B : le même fournisseur, rattaché à un chantier de B.
    const affaireB = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: otherOwner },
      payload: { label: "Chantier de B", status: "EN_COURS" },
    });
    const documentB = await withTenant(orgB, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgB,
          fileName: "b.jpg",
          mimeType: "image/jpeg",
          byteSize: 12,
          sha256: `sha-f2-b-${RUN}`,
          photo: Buffer.from("photo"),
          docType: "facture_fournisseur",
          extraction: { supplierName: "Fournisseur Partagé", docDate: "2026-06-01" },
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: `/affaires/${affaireB.json().id}/imputations`,
      headers: { cookie: otherOwner },
      payload: {
        targetType: "classeur_document",
        targetId: documentB.id,
        amountCents: 9_000,
        amountBasis: "ttc",
      },
    });

    // Chez A : même fournisseur, une seule affaire ouverte sans dates.
    await createAffaire({ label: "Chantier de A", status: "EN_COURS" });
    const documentA = await newDocument(
      "Fournisseur Partagé",
      "2026-06-02",
      `sha-f2-a-${RUN}`,
    );
    const res = await app.inject({
      method: "GET",
      url: `/classeur/documents/${documentA.id}/affaires-suggerees`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    // Aucune suggestion ne doit s'appuyer sur ce que B a fait.
    const reasons = body.kind === "suggestions" ? body.items.flatMap((i: { reasons: unknown[] }) => i.reasons) : [];
    expect(reasons).not.toContainEqual(expect.objectContaining({ kind: "historique_fournisseur" }));
    // Et surtout : jamais le chantier de B.
    if (body.kind === "suggestions") {
      expect(body.items.every((i: { affaireId: string }) => i.affaireId !== affaireB.json().id)).toBe(true);
    }
  });

  it("une imputation AUTO est REFUSÉE : rien n'écrit sans validation humaine", async () => {
    // La doc promet « AUTO reste inutilisé ». Sans ce refus, un client pouvait
    // en poser une, et elle entrait dans la marge.
    const chantier = await createAffaire({ label: "Anti-AUTO", status: "EN_COURS" });
    const res = await app.inject({
      method: "POST",
      url: `/affaires/${chantier}/imputations`,
      headers: { cookie: memberCookie },
      payload: {
        targetType: "charge",
        targetId: `auto-${RUN}`,
        source: "AUTO",
        amountCents: 1_000,
        amountBasis: "ht",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepter une suggestion s'enregistre en CONFIRMEE — c'est la mesure de F2", async () => {
    const chantier = await createAffaire({ label: "Mesurable", status: "EN_COURS" });
    const document = await newDocument("Castorama", "2026-06-07", `sha-f2-conf-${RUN}`);
    const accepted = await app.inject({
      method: "POST",
      url: `/affaires/${chantier}/imputations`,
      headers: { cookie: memberCookie },
      payload: {
        targetType: "classeur_document",
        targetId: document.id,
        source: "CONFIRMEE",
        amountCents: 8_000,
        amountBasis: "ttc",
      },
    });
    expect(accepted.statusCode).toBe(201);
    const row = await withTenant(orgA, (tx) =>
      tx.affaireImputation.findUnique({ where: { id: accepted.json().id } }),
    );
    expect(row?.source).toBe("CONFIRMEE");
  });
});

describe("F4 — la marge de chaque chantier dans le cockpit", () => {
  it("sépare ce qui est à surveiller, ce qui est chiffrable, et ce qu'on ne sait PAS chiffrer", async () => {
    // Un classement unique ferait passer « inconnu » pour « va bien ». Les
    // trois groupes existent pour que ce soit impossible.
    await withTenant(orgA, (tx) =>
      tx.tenantProfile.upsert({
        where: { tenantId: orgA },
        create: { tenantId: orgA, hourlyCostCents: 3_500 },
        update: { hourlyCostCents: 3_500 },
      }),
    );

    // Un chantier qui PERD de l'argent.
    const perdant = await createAffaire({
      label: "Chantier perdant",
      status: "EN_COURS",
      quotedAmountCents: 100_000,
      hoursWorked: 0,
    });
    await app.inject({
      method: "POST",
      url: `/affaires/${perdant}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-f4-perdant-${RUN}`,
        amountCents: 250_000,
        amountBasis: "ht",
      },
    });

    // Un chantier sain.
    const sain = await createAffaire({
      label: "Chantier sain",
      status: "EN_COURS",
      quotedAmountCents: 1_000_000,
      hoursWorked: 0,
    });
    await app.inject({
      method: "POST",
      url: `/affaires/${sain}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-f4-sain-${RUN}`,
        amountCents: 200_000,
        amountBasis: "ht",
      },
    });

    // Un chantier dont on ne sait rien.
    const inconnu = await createAffaire({
      label: "Chantier vide",
      status: "EN_COURS",
      quotedAmountCents: 500_000,
    });

    const res = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.aSurveiller.some((r: { id: string }) => r.id === perdant)).toBe(true);
    expect(body.chiffrables.some((r: { id: string }) => r.id === sain)).toBe(true);
    // Le chantier vide n'est NI à surveiller NI chiffrable : il est nommé.
    expect(body.nonChiffrables.some((r: { id: string }) => r.id === inconnu)).toBe(true);
    expect(body.aSurveiller.some((r: { id: string }) => r.id === inconnu)).toBe(false);
    expect(body.chiffrables.some((r: { id: string }) => r.id === inconnu)).toBe(false);
  });

  it("le pire chantier est en tête : c'est celui sur lequel on peut encore agir", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    const surveiller = res.json().aSurveiller as { margin: { marginCents?: number } }[];
    if (surveiller.length > 1) {
      const first = surveiller[0]?.margin.marginCents ?? 0;
      const second = surveiller[1]?.margin.marginCents ?? 0;
      expect(first).toBeLessThanOrEqual(second);
    }
    expect(surveiller.length).toBeGreaterThan(0);
  });

  it("la marge du cockpit est la MÊME que celle de la fiche — un seul moteur", async () => {
    // Deux calculs qui divergent, c'est le patron qui découvre deux chiffres
    // pour le même chantier.
    const liste = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    const rows = [...liste.json().aSurveiller, ...liste.json().chiffrables] as {
      id: string;
      margin: { kind: string; marginCents?: number };
    }[];
    const sample = rows[0];
    if (!sample) throw new Error("au moins une affaire chiffrable attendue");
    const fiche = await app.inject({
      method: "GET",
      url: `/affaires/${sample.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(fiche.json().marge.kind).toBe(sample.margin.kind);
    expect(fiche.json().marge.marginCents).toBe(sample.margin.marginCents);
  });

  it("un PLAFOND positif n'est jamais « dans le vert »", async () => {
    // Le trou trouvé en revue, et c'est le flux NOMINAL : sans coût horaire,
    // sans heures, ou avec des pièces en TTC, le plafond vaut presque le devis
    // entier — pendant que la marge réelle peut être négative. Le compter avec
    // les rentables affichait « N chantiers dans le vert » sur des chantiers
    // dont on ne sait rien.
    const doute = await createAffaire({
      label: "Marge incertaine",
      status: "EN_COURS",
      quotedAmountCents: 1_000_000,
      // Heures NON renseignées => borne supérieure.
    });
    await app.inject({
      method: "POST",
      url: `/affaires/${doute}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-f4-doute-${RUN}`,
        amountCents: 50_000,
        amountBasis: "ht",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    expect(body.sousReserve.some((r: { id: string }) => r.id === doute)).toBe(true);
    expect(body.chiffrables.some((r: { id: string }) => r.id === doute)).toBe(false);
    // Et tout ce qui est « dans le vert » a une marge EXACTE.
    expect(
      body.chiffrables.every((r: { margin: { kind: string } }) => r.margin.kind === "marge"),
    ).toBe(true);
  });

  it("une affaire sans devis sort en non-chiffrable, avec SA cause", async () => {
    const sansDevis = await createAffaire({ label: "Sans devis", status: "EN_COURS" });
    await app.inject({
      method: "POST",
      url: `/affaires/${sansDevis}/imputations`,
      headers: { cookie: ownerCookie },
      payload: {
        targetType: "transaction_bancaire",
        targetId: `tx-f4-nodevis-${RUN}`,
        amountCents: 30_000,
        amountBasis: "ht",
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    const row = res
      .json()
      .nonChiffrables.find((r: { id: string }) => r.id === sansDevis) as
      | { margin: { kind: string } }
      | undefined;
    expect(row?.margin.kind).toBe("couts_seuls");
  });

  it("module `affaires` éteint : la carte disparaît (409), elle ne ment pas", async () => {
    await app.inject({
      method: "PUT",
      url: "/modules/affaires",
      headers: { cookie: ownerCookie },
      payload: { active: false },
    });
    const off = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    expect(off.statusCode).toBe(409);
    await app.inject({
      method: "PUT",
      url: "/modules/affaires",
      headers: { cookie: ownerCookie },
      payload: { active: true },
    });
    const on = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    expect(on.statusCode).toBe(200);
  });

  it("réservée au dirigeant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("« marges » n'est pas confondu avec un identifiant d'affaire", async () => {
    // Route statique vs paramétrique : si l'ordre changeait, le cockpit
    // recevrait un 400 « invalid id » au lieu de ses chiffres.
    const res = await app.inject({
      method: "GET",
      url: "/affaires/marges",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).not.toBe(400);
  });
});

describe("F5 — le brief du matin", () => {
  it("dit ce qu'il n'a PAS pu regarder, au lieu de l'omettre", async () => {
    // Un brief silencieux sur les impayés faute d'import comptable laisserait
    // croire qu'il n'y en a pas — le pire mensonge possible sur cet écran.
    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.blindSpots)).toBe(true);
    expect(["calme", "brief"]).toContain(body.kind);
  });

  it("un MEMBRE reçoit un brief sans montants, et on le lui dit", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const areas = body.blindSpots.map((spot: { area: string }) => spot.area);
    expect(areas).toContain("montants et échéances");
    // Aucune ligne financière ne doit avoir fuité.
    const items = body.kind === "brief" ? body.items : [];
    expect(
      items.every((item: { kind: string }) =>
        ["actions_a_valider", "documents_a_verifier", "stock_sous_seuil"].includes(item.kind),
      ),
    ).toBe(true);
  });

  it("une affaire en perte remonte en tête du brief du dirigeant", async () => {
    // Le chantier « perdant » créé plus haut a une marge négative connue.
    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    expect(body.kind).toBe("brief");
    const perte = body.items.find(
      (item: { kind: string }) => item.kind === "affaire_en_perte",
    );
    expect(perte).toBeDefined();
    expect(perte.severity).toBe("urgent");
    // Le montant affiché est le PIRE, donc négatif.
    expect(perte.amountCents).toBeLessThan(0);
  });

  it("l'échéance vient du CALENDRIER, pas de la table d'annotations", async () => {
    /*
     * LE test de ce ticket. La table `tax_deadlines` ne porte QUE les décisions
     * humaines : le calendrier, lui, est recalculé (2.9). Lire la table seule
     * laissait le brief muet sur une CA3 due dans deux jours tant que personne
     * ne l'avait annotée — c'est-à-dire dans le cas nominal.
     *
     * La preuve tient à `applyTaxOverrides`, qui IGNORE une surcharge ne
     * correspondant à aucune occurrence : si la ligne remonte, c'est que le
     * calendrier a bien été construit depuis le régime de TVA du profil.
     */
    await app.inject({
      method: "PUT",
      url: "/echeancier/profil",
      headers: { cookie: ownerCookie },
      payload: {
        vatRegime: "reel_normal_mensuel",
        corporateTaxLiable: true,
        fiscalYearEndMonth: 12,
        payrollPeriodicity: "aucune",
      },
    });

    // CA3 du mois dernier : toujours passée, toujours dans la fenêtre de 60 j.
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const dueDate = lastMonth.toISOString().slice(0, 10);

    // Sans annotation : rien n'est AFFIRMÉ, mais l'angle mort est déclaré.
    const muet = (
      await app.inject({ method: "GET", url: "/brief", headers: { cookie: ownerCookie } })
    ).json();
    const muetItems = muet.kind === "brief" ? muet.items : [];
    expect(
      muetItems.some((item: { kind: string }) => item.kind === "echeance_en_retard"),
    ).toBe(false);
    expect(
      muet.blindSpots.some((spot: { why: string }) => spot.why.includes("non pointée")),
    ).toBe(true);

    // Pointée par l'humain : le retard devient une affirmation.
    await app.inject({
      method: "PUT",
      url: "/echeancier/deadline",
      headers: { cookie: ownerCookie },
      payload: {
        obligationId: "tva_ca3",
        dueDate,
        amountCents: 250_000,
        status: "prevu",
        note: null,
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    expect(body.kind).toBe("brief");
    const retard = body.items.find(
      (item: { kind: string }) => item.kind === "echeance_en_retard",
    );
    expect(retard).toBeDefined();
    expect(retard.severity).toBe("urgent");
    expect(retard.amountCents).toBe(250_000);

    // Remise à l'état neutre : les cas suivants ne doivent pas hériter du régime.
    await app.inject({
      method: "PUT",
      url: "/echeancier/deadline",
      headers: { cookie: ownerCookie },
      payload: {
        obligationId: "tva_ca3",
        dueDate,
        amountCents: null,
        status: "paye",
        note: null,
      },
    });
    await app.inject({
      method: "PUT",
      url: "/echeancier/profil",
      headers: { cookie: ownerCookie },
      payload: {
        vatRegime: "inconnu",
        corporateTaxLiable: true,
        fiscalYearEndMonth: 12,
        payrollPeriodicity: "aucune",
      },
    });
  });

  it("un régime de TVA non renseigné devient un ANGLE MORT, pas un silence", async () => {
    // « Aucune échéance » se lirait « rien à payer ». Le calendrier sait qu'il
    // ne sait pas, et le brief relaie ce refus motivé.
    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    expect(
      body.blindSpots.some(
        (spot: { area: string; why: string }) =>
          spot.area === "échéancier" && spot.why.includes("TVA"),
      ),
    ).toBe(true);
  });

  it("une facture au solde NUL n'est pas un impayé (même filtre que US-8)", async () => {
    // Une facture soldée par une pièce distincte garde `settled: false` et une
    // échéance passée : sans le filtre sur le solde, elle ressort en retard et
    // fait relancer un client qui a payé.
    const imported = await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-brief-${RUN}`,
          entryCount: 1,
          customerCount: 1,
          invoiceCount: 1,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    await withTenant(orgA, (tx) =>
      tx.fecInvoice.create({
        data: {
          tenantId: orgA,
          importId: imported.id,
          customerRef: "411SOLDE",
          number: `F-SOLDE-${RUN}`,
          issuedDate: new Date("2026-01-01"),
          dueDate: new Date("2026-02-01"),
          amountCents: 400_000n,
          residualCents: 0n,
          settled: false,
        },
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    const items = body.kind === "brief" ? body.items : [];
    expect(items.some((item: { kind: string }) => item.kind === "impayes")).toBe(false);
  });

  it("module affaires éteint : le brief le DIT et ne prétend rien savoir", async () => {
    await app.inject({
      method: "PUT",
      url: "/modules/affaires",
      headers: { cookie: ownerCookie },
      payload: { active: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/brief",
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    const areas = body.blindSpots.map((spot: { area: string }) => spot.area);
    expect(areas).toContain("affaires");
    const items = body.kind === "brief" ? body.items : [];
    expect(items.some((item: { kind: string }) => item.kind === "affaire_en_perte")).toBe(false);

    await app.inject({
      method: "PUT",
      url: "/modules/affaires",
      headers: { cookie: ownerCookie },
      payload: { active: true },
    });
  });
});

describe("F6 — la file de validation recentrée sur l'affaire", () => {
  async function createPendingAction(): Promise<string> {
    const created = await withTenant(orgA, (tx) =>
      tx.pendingAction.create({
        data: {
          tenantId: orgA,
          type: "send_dunning",
          status: "pending",
          payload: { draft: "Relance à relire" },
        },
      }),
    );
    return created.id;
  }

  it("une action sans chantier reste parfaitement valide", async () => {
    // Règle de structure n°1 : tout rattachement est NULLABLE. Une action de
    // frais généraux — essence, assurance — n'a pas de chantier, et c'est le
    // cas majoritaire au démarrage.
    await createPendingAction();
    const res = await app.inject({
      method: "GET",
      url: "/pending-actions",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const orphan = res.json().find((a: { affaireId: string | null }) => a.affaireId === null);
    expect(orphan).toBeDefined();
  });

  it("rattachée, l'action DIT de quel chantier il s'agit", async () => {
    // Sans ça, l'owner validait « Relance — Facture 2026-124 » sans savoir sur
    // quel chantier, dans un produit dont l'affaire est le pivot.
    const affaireId = await createAffaire({ label: "Toiture Bardin" });
    const actionId = await createPendingAction();
    const patched = await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId },
    });
    expect(patched.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/pending-actions",
      headers: { cookie: ownerCookie },
    });
    const line = res.json().find((a: { id: string }) => a.id === actionId);
    expect(line.affaireId).toBe(affaireId);
    expect(line.affaire.label).toBe("Toiture Bardin");
    expect(line.affaire.reference).toMatch(/\d{4}-\d{3}/);
  });

  it("un rattachement se DÉTACHE : il se corrige, il ne se subit pas", async () => {
    const affaireId = await createAffaire({ label: "Mauvais chantier" });
    const actionId = await createPendingAction();
    await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId },
    });
    const detached = await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId: null },
    });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().affaireId).toBeNull();
  });

  it("une affaire inconnue est un REFUS motivé, jamais un 500", async () => {
    const actionId = await createPendingAction();
    const res = await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("affaire");
  });

  it("un MEMBRE ne classe pas ce qu'il ne peut pas lire", async () => {
    // Le payload est owner-gated (1.5) : demander à un membre de ranger une
    // action serait lui demander de la ranger à l'aveugle. C'est l'inverse de
    // l'imputation d'une pièce (4.1), ouverte à tous parce que l'employé de
    // terrain a la facture sous les yeux.
    const affaireId = await createAffaire({ label: "Interdit au membre" });
    const actionId = await createPendingAction();
    const res = await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: memberCookie },
      payload: { affaireId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("après décision, le rattachement ne se réécrit plus", async () => {
    // Une ligne décidée est une TRACE, et une trace ne se réécrit pas — même
    // règle que le brouillon.
    const affaireId = await createAffaire({ label: "Déjà décidé" });
    const actionId = await createPendingAction();
    await withTenant(orgA, (tx) =>
      tx.pendingAction.update({ where: { id: actionId }, data: { status: "executed" } }),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId },
    });
    expect(res.statusCode).toBe(409);
  });

  it("la fiche du chantier montre ce qui attend une décision", async () => {
    const affaireId = await createAffaire({ label: "Avec décisions" });
    const actionId = await createPendingAction();
    await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId },
    });
    const res = await app.inject({
      method: "GET",
      url: `/affaires/${affaireId}`,
      headers: { cookie: ownerCookie },
    });
    const actions = res.json().actionsAValider;
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("send_dunning");
    // Métadonnées SEULEMENT : le brouillon reste derrière son endpoint owner.
    expect(actions[0].payload).toBeUndefined();
  });

  it("le rattachement d'une action ne bouge PAS la marge", async () => {
    // Une décision n'est pas un coût. Si rattacher une relance changeait la
    // marge du chantier, le chiffre le plus regardé du produit deviendrait
    // faux au premier classement.
    const affaireId = await createAffaire({
      label: "Marge stable",
      quotedAmountCents: 1_000_000,
    });
    const before = await app.inject({
      method: "GET",
      url: `/affaires/${affaireId}`,
      headers: { cookie: ownerCookie },
    });
    const actionId = await createPendingAction();
    await app.inject({
      method: "PATCH",
      url: `/pending-actions/${actionId}/affaire`,
      headers: { cookie: ownerCookie },
      payload: { affaireId },
    });
    const after = await app.inject({
      method: "GET",
      url: `/affaires/${affaireId}`,
      headers: { cookie: ownerCookie },
    });
    expect(after.json().marge).toEqual(before.json().marge);
    expect(after.json().invoicedCents).toBe(before.json().invoicedCents);
  });
});
