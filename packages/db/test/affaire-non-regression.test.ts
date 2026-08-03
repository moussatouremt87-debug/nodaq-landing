import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant, nextAffaireReference } from "../src/index.js";
import { createAdminClient } from "../src/admin.js";

/*
 * NON-RÉGRESSION — le livrable n°1 du ticket 4.1.
 *
 * L'affaire est le pivot du produit, mais elle arrive dans un produit qui
 * tourne déjà. La règle est donc l'inverse de l'intuition : une pièce SANS
 * affaire n'est pas un cas dégradé à tolérer, c'est le cas MAJORITAIRE — le
 * plein d'essence, la prime d'assurance, l'abonnement téléphonique.
 *
 * Rendre `affaireId` obligatoire « pour la propreté » est la façon la plus
 * rapide de casser tout l'existant et de bloquer l'utilisateur dès le premier
 * jour. Ce fichier existe pour que ça se voie tout de suite.
 *
 * La preuve d'ensemble est ailleurs : la suite complète (245 tests d'API, 153
 * d'outils MCP…) passe SANS modification. Ce fichier-ci vise ce qu'une suite
 * verte ne montre pas : que le rattachement reste facultatif dans le temps,
 * y compris après archivage.
 */

let admin: PrismaClient;
let tenantId: string;

beforeAll(async () => {
  admin = createAdminClient();
  await admin.affaireImputation.deleteMany();
  await admin.affaire.deleteMany();
  await admin.affaireCounter.deleteMany();
  await admin.tenant.deleteMany({ where: { slug: { startsWith: "aff-nr-" } } });
  const tenant = await admin.tenant.create({ data: { name: "NR", slug: "aff-nr-a" } });
  tenantId = tenant.id;
});

afterAll(async () => {
  await admin.affaireImputation.deleteMany();
  await admin.affaire.deleteMany();
  await admin.affaireCounter.deleteMany();
  await admin.tenant.deleteMany({ where: { slug: { startsWith: "aff-nr-" } } });
  await admin.$disconnect();
  await prisma.$disconnect();
});

const photo = Buffer.from("photo-de-test");

describe("l'existant fonctionne sans jamais connaître les affaires", () => {
  it("un document du classeur se crée, se lit et se corrige SANS affaire", async () => {
    const created = await withTenant(tenantId, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId,
          fileName: "essence.jpg",
          mimeType: "image/jpeg",
          byteSize: photo.byteLength,
          sha256: "sha-essence",
          photo,
          docType: "recu",
        },
      }),
    );
    expect(created.affaireId).toBeNull();

    // Le parcours complet du classeur (correction puis rapprochement bancaire)
    // ne touche jamais au rattachement d'affaire.
    const corrected = await withTenant(tenantId, (tx) =>
      tx.classeurDocument.update({
        where: { id: created.id },
        data: { status: "verifie", extraction: { supplierName: "Station", totalInclTax: 82.4 } },
      }),
    );
    expect(corrected.affaireId).toBeNull();
    expect(corrected.status).toBe("verifie");

    const matched = await withTenant(tenantId, (tx) =>
      tx.classeurDocument.update({
        where: { id: created.id },
        data: { matchedTransactionId: "qonto-tx-42", matchedAt: new Date(), status: "rapproche" },
      }),
    );
    expect(matched.affaireId).toBeNull();
  });

  it("une facture importée du FEC vit sans affaire", async () => {
    const fecImport = await withTenant(tenantId, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId,
          fileHash: "hash-nr",
          entryCount: 1,
          customerCount: 1,
          invoiceCount: 1,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const invoice = await withTenant(tenantId, (tx) =>
      tx.fecInvoice.create({
        data: {
          tenantId,
          importId: fecImport.id,
          customerRef: "411CLIENT",
          number: "F-001",
          issuedDate: new Date("2026-06-01"),
          dueDate: new Date("2026-07-01"),
          amountCents: 120_000n,
          residualCents: 120_000n,
          settled: false,
        },
      }),
    );
    expect(invoice.affaireId).toBeNull();

    // La lecture des impayés (relances) ne filtre pas sur l'affaire : une
    // facture sans chantier doit rester relançable.
    const overdue = await withTenant(tenantId, (tx) =>
      tx.fecInvoice.findMany({ where: { settled: false } }),
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.affaireId).toBeNull();
  });

  it("le profil du tenant existe sans coût horaire — jamais deviné", async () => {
    const profile = await withTenant(tenantId, (tx) =>
      tx.tenantProfile.create({ data: { tenantId, vertical: "industrie_btp" } }),
    );
    // Sans coût horaire, le calcul rendra une BORNE SUPÉRIEURE ; il ne comptera
    // pas zéro heure de travail.
    expect(profile.hourlyCostCents).toBeNull();
  });
});

describe("archiver ne détache rien", () => {
  it("une affaire ARCHIVEE conserve ses pièces et ses imputations", async () => {
    const document = await withTenant(tenantId, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId,
          fileName: "carrelage.jpg",
          mimeType: "image/jpeg",
          byteSize: photo.byteLength,
          sha256: "sha-carrelage",
          photo,
          docType: "facture_fournisseur",
        },
      }),
    );

    const affaire = await withTenant(tenantId, async (tx) => {
      const reference = await nextAffaireReference(tx, tenantId, 2026);
      return tx.affaire.create({ data: { tenantId, reference, label: "Cuisine", status: "EN_COURS" } });
    });

    await withTenant(tenantId, (tx) =>
      tx.classeurDocument.update({
        where: { id: document.id },
        data: { affaireId: affaire.id },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.affaireImputation.create({
        data: {
          tenantId,
          affaireId: affaire.id,
          targetType: "classeur_document",
          targetId: document.id,
          amountCents: 45_000n,
          amountBasis: "ht",
        },
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.affaire.update({ where: { id: affaire.id }, data: { status: "ARCHIVEE" } }),
    );

    // Des pièces comptables y sont rattachées : archiver range, ça n'efface pas.
    const stillLinked = await withTenant(tenantId, (tx) =>
      tx.classeurDocument.findUnique({ where: { id: document.id } }),
    );
    expect(stillLinked?.affaireId).toBe(affaire.id);
    const imputations = await withTenant(tenantId, (tx) =>
      tx.affaireImputation.findMany({ where: { affaireId: affaire.id, revokedAt: null } }),
    );
    expect(imputations).toHaveLength(1);
  });

  it("désimputer RÉVOQUE, ça ne supprime pas — la trace reste", async () => {
    const affaire = await withTenant(tenantId, async (tx) => {
      const reference = await nextAffaireReference(tx, tenantId, 2026);
      return tx.affaire.create({ data: { tenantId, reference, label: "Terrasse" } });
    });
    const imputation = await withTenant(tenantId, (tx) =>
      tx.affaireImputation.create({
        data: {
          tenantId,
          affaireId: affaire.id,
          targetType: "transaction_bancaire",
          targetId: "qonto-tx-99",
          amountCents: 12_000n,
          amountBasis: "ttc",
        },
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.affaireImputation.update({
        where: { id: imputation.id },
        data: { revokedAt: new Date(), revokedBy: "user-test" },
      }),
    );

    const active = await withTenant(tenantId, (tx) =>
      tx.affaireImputation.findMany({ where: { affaireId: affaire.id, revokedAt: null } }),
    );
    expect(active).toHaveLength(0);
    // La ligne reste : c'est elle qui expliquera un chiffre a posteriori, et
    // qui nourrira l'apprentissage de l'imputation automatique (F2).
    const all = await withTenant(tenantId, (tx) =>
      tx.affaireImputation.findMany({ where: { affaireId: affaire.id } }),
    );
    expect(all).toHaveLength(1);
    expect(all[0]?.revokedBy).toBe("user-test");

    // Et la pièce redevient imputable ailleurs : l'unicité ne joue que sur les
    // imputations actives.
    const other = await withTenant(tenantId, async (tx) => {
      const reference = await nextAffaireReference(tx, tenantId, 2026);
      return tx.affaire.create({ data: { tenantId, reference, label: "Autre" } });
    });
    const reimputed = await withTenant(tenantId, (tx) =>
      tx.affaireImputation.create({
        data: {
          tenantId,
          affaireId: other.id,
          targetType: "transaction_bancaire",
          targetId: "qonto-tx-99",
          amountCents: 12_000n,
          amountBasis: "ttc",
        },
      }),
    );
    expect(reimputed.id).not.toBe(imputation.id);
  });
});
