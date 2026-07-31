import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "../src/index.js";
import { createAdminClient } from "../src/admin.js";

/**
 * Tests d'isolation multi-tenant — LE livrable du ticket 0.1.
 * Base réelle (Postgres), rôle applicatif non-superuser, RLS forcée sur `notes`.
 */

let admin: PrismaClient;
let tenantA: string;
let tenantB: string;
let noteAId: string;
let noteBId: string;
let classificationAId: string;
let classificationBId: string;
let policyAId: string;
let policyBId: string;
let connectorAId: string;
let connectorBId: string;
let documentAId: string;
let documentBId: string;
let documentChunkAId: string;
let documentChunkBId: string;
let pendingActionAId: string;
let pendingActionBId: string;
let agentConversationAId: string;
let agentConversationBId: string;
let fecImportAId: string;
let fecImportBId: string;
let fecInvoiceAId: string;
let fecInvoiceBId: string;
let classeurDocumentAId: string;
let classeurDocumentBId: string;
let stockItemAId: string;
let stockItemBId: string;
let stockMovementAId: string;
let stockMovementBId: string;
let pushSubscriptionAId: string;
let pushSubscriptionBId: string;
let pushDispatchStateAId: string;
let pushDispatchStateBId: string;
let fixedAssetAId: string;
let fixedAssetBId: string;
let staffMemberAId: string;
let staffMemberBId: string;
let staffAbsenceAId: string;
let staffAbsenceBId: string;
let tenantProfileAId: string;
let tenantProfileBId: string;
let customerReviewAId: string;
let customerReviewBId: string;
let processingActivityAId: string;
let processingActivityBId: string;
let webhookEndpointAId: string;
let webhookEndpointBId: string;
let webhookEventAId: string;
let webhookEventBId: string;
let einvoiceSubmissionAId: string;
let einvoiceSubmissionBId: string;
let taxDeadlineAId: string;
let taxDeadlineBId: string;

beforeAll(async () => {
  admin = createAdminClient();
  await admin.note.deleteMany();
  await admin.classification.deleteMany();
  await admin.tenantPolicy.deleteMany();
  await admin.connector.deleteMany();
  await admin.pendingAction.deleteMany();
  await admin.agentConversation.deleteMany();
  // FK order: invoices before imports.
  await admin.fecInvoice.deleteMany();
  await admin.fecImport.deleteMany();
  await admin.classeurDocument.deleteMany();
  // FK order: movements before items.
  await admin.stockMovement.deleteMany();
  await admin.stockItem.deleteMany();
  await admin.pushSubscription.deleteMany();
  await admin.pushDispatchState.deleteMany();
  await admin.fixedAsset.deleteMany();
  // FK order: absences before members.
  await admin.staffAbsence.deleteMany();
  await admin.staffMember.deleteMany();
  await admin.tenantProfile.deleteMany();
  await admin.customerReview.deleteMany();
  await admin.processingActivity.deleteMany();
  // FK order: events before endpoints.
  await admin.webhookEvent.deleteMany();
  await admin.webhookEndpoint.deleteMany();
  await admin.eInvoiceSubmission.deleteMany();
  await admin.taxDeadline.deleteMany();
  // FK order: chunks before documents.
  await admin.documentChunk.deleteMany();
  await admin.document.deleteMany();
  await admin.membership.deleteMany();
  await admin.user.deleteMany();
  await admin.tenant.deleteMany();

  const a = await admin.tenant.create({ data: { name: "Tenant A" } });
  const b = await admin.tenant.create({ data: { name: "Tenant B" } });
  tenantA = a.id;
  tenantB = b.id;

  // Les notes sont créées via withTenant : la RLS (WITH CHECK) s'applique aussi à l'INSERT.
  const noteA = await withTenant(tenantA, (tx) =>
    tx.note.create({ data: { tenantId: tenantA, title: "note A", body: "secret de A" } }),
  );
  const noteB = await withTenant(tenantB, (tx) =>
    tx.note.create({ data: { tenantId: tenantB, title: "note B", body: "secret de B" } }),
  );
  noteAId = noteA.id;
  noteBId = noteB.id;

  // Idem pour classifications : le content_hash est un placeholder de test, jamais
  // du contenu réel.
  const classificationA = await withTenant(tenantA, (tx) =>
    tx.classification.create({
      data: {
        tenantId: tenantA,
        requestId: "req-a-1",
        category: "confidentiel",
        tier: "sovereign-fast",
        decidedBy: "rules",
        contentHash: "hash-a",
      },
    }),
  );
  const classificationB = await withTenant(tenantB, (tx) =>
    tx.classification.create({
      data: {
        tenantId: tenantB,
        requestId: "req-b-1",
        category: "interne",
        tier: "sovereign-fast",
        decidedBy: "llm",
        contentHash: "hash-b",
      },
    }),
  );
  classificationAId = classificationA.id;
  classificationBId = classificationB.id;

  const policyA = await withTenant(tenantA, (tx) =>
    tx.tenantPolicy.create({ data: { tenantId: tenantA, frontierEnabled: false } }),
  );
  const policyB = await withTenant(tenantB, (tx) =>
    tx.tenantPolicy.create({ data: { tenantId: tenantB, frontierEnabled: true } }),
  );
  policyAId = policyA.id;
  policyBId = policyB.id;

  // credentialsRef est le NOM du secret dans le Secret Manager — jamais une valeur
  // de credential (placeholder de test).
  const connectorA = await withTenant(tenantA, (tx) =>
    tx.connector.create({
      data: { tenantId: tenantA, type: "pennylane", credentialsRef: "connector-a-pennylane" },
    }),
  );
  const connectorB = await withTenant(tenantB, (tx) =>
    tx.connector.create({
      data: { tenantId: tenantB, type: "qonto", credentialsRef: "connector-b-qonto" },
    }),
  );
  connectorAId = connectorA.id;
  connectorBId = connectorB.id;

  // documents/document_chunks : embedding reste NULL ici (Prisma exclut les colonnes
  // Unsupported des types create/select — pas de raw SQL nécessaire pour ces tests
  // d'isolation, qui ne portent pas sur le contenu vectoriel).
  const documentA = await withTenant(tenantA, (tx) =>
    tx.document.create({
      data: { tenantId: tenantA, dept: "rh", hash: "hash-doc-a" },
    }),
  );
  const documentB = await withTenant(tenantB, (tx) =>
    tx.document.create({
      data: { tenantId: tenantB, dept: "compta", hash: "hash-doc-b" },
    }),
  );
  documentAId = documentA.id;
  documentBId = documentB.id;

  const documentChunkA = await withTenant(tenantA, (tx) =>
    tx.documentChunk.create({
      data: {
        tenantId: tenantA,
        documentId: documentAId,
        chunkIndex: 0,
        content: "chunk secret de A",
        dept: "rh",
      },
    }),
  );
  const documentChunkB = await withTenant(tenantB, (tx) =>
    tx.documentChunk.create({
      data: {
        tenantId: tenantB,
        documentId: documentBId,
        chunkIndex: 0,
        content: "chunk secret de B",
        dept: "compta",
      },
    }),
  );
  documentChunkAId = documentChunkA.id;
  documentChunkBId = documentChunkB.id;

  // payload est l'action préparée (jamais exécutée avant validation humaine) —
  // placeholder de test, jamais une vraie donnée client.
  const pendingActionA = await withTenant(tenantA, (tx) =>
    tx.pendingAction.create({
      data: {
        tenantId: tenantA,
        type: "book_invoice",
        payload: { invoiceId: "inv-a-1" },
      },
    }),
  );
  const pendingActionB = await withTenant(tenantB, (tx) =>
    tx.pendingAction.create({
      data: {
        tenantId: tenantB,
        type: "send_dunning",
        payload: { invoiceId: "inv-b-1" },
      },
    }),
  );
  pendingActionAId = pendingActionA.id;
  pendingActionBId = pendingActionB.id;

  // messages est le transcript complet — sensible comme une note, placeholder de
  // test, jamais une vraie donnée client.
  const agentConversationA = await withTenant(tenantA, (tx) =>
    tx.agentConversation.create({
      data: {
        tenantId: tenantA,
        employee: "compta",
        messages: [{ role: "user", content: "secret de A" }],
      },
    }),
  );
  const agentConversationB = await withTenant(tenantB, (tx) =>
    tx.agentConversation.create({
      data: {
        tenantId: tenantB,
        employee: "compta",
        messages: [{ role: "user", content: "secret de B" }],
      },
    }),
  );
  agentConversationAId = agentConversationA.id;
  agentConversationBId = agentConversationB.id;

  // fileHash/warnings sont des placeholders de test, jamais un vrai fichier FEC
  // ni son contenu (donnée CONFIDENTIELLE — dérivée du journal comptable).
  const fecImportA = await withTenant(tenantA, (tx) =>
    tx.fecImport.create({
      data: {
        tenantId: tenantA,
        fileHash: "hash-fec-a",
        fileName: "fec-a.txt",
        entryCount: 10,
        customerCount: 2,
        invoiceCount: 3,
        overdueCount: 1,
        overdueCents: 12000,
      },
    }),
  );
  const fecImportB = await withTenant(tenantB, (tx) =>
    tx.fecImport.create({
      data: {
        tenantId: tenantB,
        fileHash: "hash-fec-b",
        fileName: "fec-b.txt",
        entryCount: 20,
        customerCount: 4,
        invoiceCount: 6,
        overdueCount: 2,
        overdueCents: 34000,
      },
    }),
  );
  fecImportAId = fecImportA.id;
  fecImportBId = fecImportB.id;

  // customerRef/number sont des placeholders de test, jamais une vraie donnée client.
  const fecInvoiceA = await withTenant(tenantA, (tx) =>
    tx.fecInvoice.create({
      data: {
        tenantId: tenantA,
        importId: fecImportAId,
        customerRef: "CLI-A-1",
        customerName: "Client A",
        number: "FA-A-1",
        issuedDate: new Date("2026-01-01"),
        dueDate: new Date("2026-02-01"),
        amountCents: 10000,
        residualCents: 10000,
        settled: false,
      },
    }),
  );
  const fecInvoiceB = await withTenant(tenantB, (tx) =>
    tx.fecInvoice.create({
      data: {
        tenantId: tenantB,
        importId: fecImportBId,
        customerRef: "CLI-B-1",
        customerName: "Client B",
        number: "FA-B-1",
        issuedDate: new Date("2026-01-05"),
        dueDate: new Date("2026-02-05"),
        amountCents: 20000,
        residualCents: 0,
        settled: true,
      },
    }),
  );
  fecInvoiceAId = fecInvoiceA.id;
  fecInvoiceBId = fecInvoiceB.id;

  // photo est un placeholder de test (quelques octets), jamais un vrai
  // justificatif client — donnée CONFIDENTIELLE, jamais loggée.
  const classeurDocumentA = await withTenant(tenantA, (tx) =>
    tx.classeurDocument.create({
      data: {
        tenantId: tenantA,
        fileName: "recu-a.jpg",
        mimeType: "image/jpeg",
        byteSize: 4,
        sha256: "hash-classeur-a",
        photo: Buffer.from("secret de A"),
        docType: "recu",
      },
    }),
  );
  const classeurDocumentB = await withTenant(tenantB, (tx) =>
    tx.classeurDocument.create({
      data: {
        tenantId: tenantB,
        fileName: "recu-b.jpg",
        mimeType: "image/jpeg",
        byteSize: 4,
        sha256: "hash-classeur-b",
        photo: Buffer.from("secret de B"),
        docType: "facture_fournisseur",
      },
    }),
  );
  classeurDocumentAId = classeurDocumentA.id;
  classeurDocumentBId = classeurDocumentB.id;

  // name/sku sont des placeholders de test, jamais un vrai article de stock client.
  const stockItemA = await withTenant(tenantA, (tx) =>
    tx.stockItem.create({
      data: { tenantId: tenantA, name: "article A", sku: "SKU-A-1", quantity: 10, alertThreshold: 2 },
    }),
  );
  const stockItemB = await withTenant(tenantB, (tx) =>
    tx.stockItem.create({
      data: { tenantId: tenantB, name: "article B", sku: "SKU-B-1", quantity: 5, alertThreshold: 1 },
    }),
  );
  stockItemAId = stockItemA.id;
  stockItemBId = stockItemB.id;

  // reason est un placeholder de test ; createdBy simule un user de session, jamais
  // un input client non recontrôlé.
  const stockMovementA = await withTenant(tenantA, (tx) =>
    tx.stockMovement.create({
      data: { tenantId: tenantA, itemId: stockItemAId, delta: -3, reason: "vente A" },
    }),
  );
  const stockMovementB = await withTenant(tenantB, (tx) =>
    tx.stockMovement.create({
      data: { tenantId: tenantB, itemId: stockItemBId, delta: 4, reason: "réappro B" },
    }),
  );
  stockMovementAId = stockMovementA.id;
  stockMovementBId = stockMovementB.id;

  // endpoint/p256dh/auth sont des placeholders de test, jamais un vrai
  // abonnement Web Push d'appareil client.
  const pushSubscriptionA = await withTenant(tenantA, (tx) =>
    tx.pushSubscription.create({
      data: {
        tenantId: tenantA,
        userId: tenantA,
        endpoint: "https://push.example.com/a",
        p256dh: "p256dh-a",
        auth: "auth-a",
        userAgent: "UA-A",
      },
    }),
  );
  const pushSubscriptionB = await withTenant(tenantB, (tx) =>
    tx.pushSubscription.create({
      data: {
        tenantId: tenantB,
        userId: tenantB,
        endpoint: "https://push.example.com/b",
        p256dh: "p256dh-b",
        auth: "auth-b",
        userAgent: "UA-B",
      },
    }),
  );
  pushSubscriptionAId = pushSubscriptionA.id;
  pushSubscriptionBId = pushSubscriptionB.id;

  // état de regroupement anti-spam — placeholder de test.
  const pushDispatchStateA = await withTenant(tenantA, (tx) =>
    tx.pushDispatchState.create({
      data: { tenantId: tenantA, userId: tenantA, category: "actions", pendingCount: 1 },
    }),
  );
  const pushDispatchStateB = await withTenant(tenantB, (tx) =>
    tx.pushDispatchState.create({
      data: { tenantId: tenantB, userId: tenantB, category: "alerts", pendingCount: 2 },
    }),
  );
  pushDispatchStateAId = pushDispatchStateA.id;
  pushDispatchStateBId = pushDispatchStateB.id;

  // label/sourceRef sont des placeholders de test, jamais une vraie immobilisation client.
  const fixedAssetA = await withTenant(tenantA, (tx) =>
    tx.fixedAsset.create({
      data: {
        tenantId: tenantA,
        label: "ordinateur A",
        category: "informatique",
        inServiceDate: new Date("2025-01-01"),
        baseCents: 120000n,
        durationMonths: 36,
      },
    }),
  );
  const fixedAssetB = await withTenant(tenantB, (tx) =>
    tx.fixedAsset.create({
      data: {
        tenantId: tenantB,
        label: "véhicule B",
        category: "vehicule",
        inServiceDate: new Date("2025-02-01"),
        baseCents: 2500000n,
        durationMonths: 60,
      },
    }),
  );
  fixedAssetAId = fixedAssetA.id;
  fixedAssetBId = fixedAssetB.id;

  // name/role sont des placeholders de test, jamais un vrai salarié client (PII).
  const staffMemberA = await withTenant(tenantA, (tx) =>
    tx.staffMember.create({
      data: { tenantId: tenantA, name: "salarié A", role: "technicien", weeklyHours: 35 },
    }),
  );
  const staffMemberB = await withTenant(tenantB, (tx) =>
    tx.staffMember.create({
      data: { tenantId: tenantB, name: "salarié B", role: "commercial", weeklyHours: 39 },
    }),
  );
  staffMemberAId = staffMemberA.id;
  staffMemberBId = staffMemberB.id;

  const staffAbsenceA = await withTenant(tenantA, (tx) =>
    tx.staffAbsence.create({
      data: {
        tenantId: tenantA,
        staffId: staffMemberAId,
        type: "conges",
        startDate: new Date("2025-08-01"),
        endDate: new Date("2025-08-15"),
      },
    }),
  );
  const staffAbsenceB = await withTenant(tenantB, (tx) =>
    tx.staffAbsence.create({
      data: {
        tenantId: tenantB,
        staffId: staffMemberBId,
        type: "maladie",
        startDate: new Date("2025-09-01"),
        endDate: new Date("2025-09-03"),
      },
    }),
  );
  staffAbsenceAId = staffAbsenceA.id;
  staffAbsenceBId = staffAbsenceB.id;

  const tenantProfileA = await withTenant(tenantA, (tx) =>
    tx.tenantProfile.create({
      data: { tenantId: tenantA, vertical: "industrie_btp", headcountOverride: 8 },
    }),
  );
  const tenantProfileB = await withTenant(tenantB, (tx) =>
    tx.tenantProfile.create({
      data: { tenantId: tenantB, vertical: "retail", headcountOverride: 3 },
    }),
  );
  tenantProfileAId = tenantProfileA.id;
  tenantProfileBId = tenantProfileB.id;

  const customerReviewA = await withTenant(tenantA, (tx) =>
    tx.customerReview.create({
      data: {
        tenantId: tenantA,
        source: "manuel",
        authorName: "Client A",
        rating: 5,
        text: "avis de A",
        reviewedAt: new Date("2025-09-01"),
      },
    }),
  );
  const customerReviewB = await withTenant(tenantB, (tx) =>
    tx.customerReview.create({
      data: {
        tenantId: tenantB,
        source: "manuel",
        authorName: "Client B",
        rating: 2,
        text: "avis de B",
        reviewedAt: new Date("2025-09-02"),
      },
    }),
  );
  customerReviewAId = customerReviewA.id;
  customerReviewBId = customerReviewB.id;

  const processingActivityA = await withTenant(tenantA, (tx) =>
    tx.processingActivity.create({
      data: {
        tenantId: tenantA,
        name: "Paie",
        purpose: "Gestion de la paie des salariés de A",
        legalBasis: "obligation_legale",
        dataCategories: ["identite", "remuneration"],
        dataSubjects: ["salaries"],
        retention: "5 ans après la fin du contrat",
      },
    }),
  );
  const processingActivityB = await withTenant(tenantB, (tx) =>
    tx.processingActivity.create({
      data: {
        tenantId: tenantB,
        name: "Paie",
        purpose: "Gestion de la paie des salariés de B",
        legalBasis: "obligation_legale",
        dataCategories: ["identite", "remuneration"],
        dataSubjects: ["salaries"],
        retention: "5 ans après la fin du contrat",
      },
    }),
  );
  processingActivityAId = processingActivityA.id;
  processingActivityBId = processingActivityB.id;

  const webhookEndpointA = await withTenant(tenantA, (tx) =>
    tx.webhookEndpoint.create({
      data: { tenantId: tenantA, provider: "test", secretRef: "secret-ref-a" },
    }),
  );
  const webhookEndpointB = await withTenant(tenantB, (tx) =>
    tx.webhookEndpoint.create({
      data: { tenantId: tenantB, provider: "test", secretRef: "secret-ref-b" },
    }),
  );
  webhookEndpointAId = webhookEndpointA.id;
  webhookEndpointBId = webhookEndpointB.id;

  const webhookEventA = await withTenant(tenantA, (tx) =>
    tx.webhookEvent.create({
      data: {
        tenantId: tenantA,
        endpointId: webhookEndpointAId,
        provider: "test",
        externalId: "evt-a-1",
        payload: { hello: "a" },
      },
    }),
  );
  const webhookEventB = await withTenant(tenantB, (tx) =>
    tx.webhookEvent.create({
      data: {
        tenantId: tenantB,
        endpointId: webhookEndpointBId,
        provider: "test",
        externalId: "evt-b-1",
        payload: { hello: "b" },
      },
    }),
  );
  webhookEventAId = webhookEventA.id;
  webhookEventBId = webhookEventB.id;

  // documentHash est un sha256 placeholder de test — cette table ne stocke NI
  // le PDF NI le XML de la facture, seulement un hash d'intégrité.
  const einvoiceSubmissionA = await withTenant(tenantA, (tx) =>
    tx.eInvoiceSubmission.create({
      data: {
        tenantId: tenantA,
        invoiceNumber: "FA-A-1",
        profile: "BASIC",
        documentHash: "hash-einvoice-a",
        amountCents: 12000,
      },
    }),
  );
  const einvoiceSubmissionB = await withTenant(tenantB, (tx) =>
    tx.eInvoiceSubmission.create({
      data: {
        tenantId: tenantB,
        invoiceNumber: "FA-B-1",
        profile: "EN16931",
        documentHash: "hash-einvoice-b",
        amountCents: 34000,
      },
    }),
  );
  einvoiceSubmissionAId = einvoiceSubmissionA.id;
  einvoiceSubmissionBId = einvoiceSubmissionB.id;

  // obligationId est un identifiant de placeholder du catalogue versionné
  // (taxCalendar.ts) ; amountCents reste NULL par défaut ici (montant DÉCLARÉ
  // par l'owner, jamais estimé par le produit) — le calendrier lui-même est
  // calculé, JAMAIS stocké : cette table ne porte que des surcharges humaines.
  const taxDeadlineA = await withTenant(tenantA, (tx) =>
    tx.taxDeadline.create({
      data: {
        tenantId: tenantA,
        obligationId: "tva-reel-normal-mensuel",
        dueDate: new Date("2026-08-24"),
        status: "prevu",
      },
    }),
  );
  const taxDeadlineB = await withTenant(tenantB, (tx) =>
    tx.taxDeadline.create({
      data: {
        tenantId: tenantB,
        obligationId: "is-acompte",
        dueDate: new Date("2026-09-15"),
        amountCents: 50000,
        status: "paye",
      },
    }),
  );
  taxDeadlineAId = taxDeadlineA.id;
  taxDeadlineBId = taxDeadlineB.id;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("garde-fou préalable", () => {
  it("le client applicatif n'est ni superuser ni BYPASSRLS (sinon les tests mentent)", async () => {
    const rows = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("la RLS est activée ET forcée sur notes", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'notes'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur classifications", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'classifications'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur tenant_policies", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenant_policies'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur connectors", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'connectors'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur documents", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'documents'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur document_chunks", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'document_chunks'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur pending_actions", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'pending_actions'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur agent_conversations", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'agent_conversations'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur fec_imports", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'fec_imports'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur fec_invoices", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'fec_invoices'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur classeur_documents", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'classeur_documents'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur stock_items", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'stock_items'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur stock_movements", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'stock_movements'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur push_subscriptions", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'push_subscriptions'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur push_dispatch_states", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'push_dispatch_states'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur fixed_assets", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'fixed_assets'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur staff_members", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'staff_members'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur staff_absences", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'staff_absences'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur customer_reviews", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'customer_reviews'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur processing_activities", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'processing_activities'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur tenant_profiles", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenant_profiles'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur webhook_endpoints", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'webhook_endpoints'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur webhook_events", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'webhook_events'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur einvoice_submissions", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'einvoice_submissions'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("la RLS est activée ET forcée sur tax_deadlines", async () => {
    const rows = await admin.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tax_deadlines'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });
});

describe("isolation tenant (RLS)", () => {
  it("test 1 — withTenant(A) ne voit QUE les notes de A", async () => {
    const notes = await withTenant(tenantA, (tx) => tx.note.findMany());
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe(noteAId);
    expect(notes.some((n) => n.tenantId === tenantB)).toBe(false);
  });

  it("test 2 — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const notes = await prisma.note.findMany();
    expect(notes).toHaveLength(0);
  });

  it("test 3 — lire la note de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.note.findUnique({ where: { id: noteBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.note.create({ data: { tenantId: tenantB, title: "intrusion", body: "..." } }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (classifications) — withTenant(A) ne voit QUE les classifications de A", async () => {
    const classifications = await withTenant(tenantA, (tx) => tx.classification.findMany());
    expect(classifications).toHaveLength(1);
    expect(classifications[0]?.id).toBe(classificationAId);
    expect(classifications.some((c) => c.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (classifications) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const classifications = await prisma.classification.findMany();
    expect(classifications).toHaveLength(0);
  });

  it("test 3 (classifications) — lire la classification de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.classification.findUnique({ where: { id: classificationBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (classifications) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.classification.create({
          data: {
            tenantId: tenantB,
            requestId: "req-intrusion",
            category: "confidentiel",
            tier: "sovereign-fast",
            decidedBy: "rules",
            contentHash: "hash-intrusion",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (tenant_policies) — withTenant(A) ne voit QUE la policy de A", async () => {
    const policies = await withTenant(tenantA, (tx) => tx.tenantPolicy.findMany());
    expect(policies).toHaveLength(1);
    expect(policies[0]?.id).toBe(policyAId);
    expect(policies.some((p) => p.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (tenant_policies) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const policies = await prisma.tenantPolicy.findMany();
    expect(policies).toHaveLength(0);
  });

  it("test 3 (tenant_policies) — lire la policy de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.tenantPolicy.findUnique({ where: { id: policyBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (tenant_policies) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.tenantPolicy.create({ data: { tenantId: tenantB, frontierEnabled: true } }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (connectors) — withTenant(A) ne voit QUE les connecteurs de A", async () => {
    const connectors = await withTenant(tenantA, (tx) => tx.connector.findMany());
    expect(connectors).toHaveLength(1);
    expect(connectors[0]?.id).toBe(connectorAId);
    expect(connectors.some((c) => c.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (connectors) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const connectors = await prisma.connector.findMany();
    expect(connectors).toHaveLength(0);
  });

  it("test 3 (connectors) — lire le connecteur de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.connector.findUnique({ where: { id: connectorBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (connectors) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.connector.create({
          data: { tenantId: tenantB, type: "intrusion", credentialsRef: "connector-intrusion" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (documents) — withTenant(A) ne voit QUE les documents de A", async () => {
    const documents = await withTenant(tenantA, (tx) => tx.document.findMany());
    expect(documents).toHaveLength(1);
    expect(documents[0]?.id).toBe(documentAId);
    expect(documents.some((d) => d.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (documents) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const documents = await prisma.document.findMany();
    expect(documents).toHaveLength(0);
  });

  it("test 3 (documents) — lire le document de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.document.findUnique({ where: { id: documentBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (documents) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.document.create({
          data: { tenantId: tenantB, dept: "rh", hash: "hash-intrusion" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (document_chunks) — withTenant(A) ne voit QUE les chunks de A", async () => {
    const chunks = await withTenant(tenantA, (tx) => tx.documentChunk.findMany());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.id).toBe(documentChunkAId);
    expect(chunks.some((c) => c.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (document_chunks) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const chunks = await prisma.documentChunk.findMany();
    expect(chunks).toHaveLength(0);
  });

  it("test 3 (document_chunks) — lire le chunk de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.documentChunk.findUnique({ where: { id: documentChunkBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (document_chunks) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.documentChunk.create({
          data: {
            tenantId: tenantB,
            documentId: documentBId,
            chunkIndex: 99,
            content: "intrusion",
            dept: "rh",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (pending_actions) — withTenant(A) ne voit QUE les pending actions de A", async () => {
    const pendingActions = await withTenant(tenantA, (tx) => tx.pendingAction.findMany());
    expect(pendingActions).toHaveLength(1);
    expect(pendingActions[0]?.id).toBe(pendingActionAId);
    expect(pendingActions.some((p) => p.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (pending_actions) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const pendingActions = await prisma.pendingAction.findMany();
    expect(pendingActions).toHaveLength(0);
  });

  it("test 3 (pending_actions) — lire la pending action de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.pendingAction.findUnique({ where: { id: pendingActionBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (pending_actions) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.pendingAction.create({
          data: {
            tenantId: tenantB,
            type: "intrusion",
            payload: { invoiceId: "intrusion" },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (agent_conversations) — withTenant(A) ne voit QUE les conversations de A", async () => {
    const conversations = await withTenant(tenantA, (tx) => tx.agentConversation.findMany());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe(agentConversationAId);
    expect(conversations.some((c) => c.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (agent_conversations) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const conversations = await prisma.agentConversation.findMany();
    expect(conversations).toHaveLength(0);
  });

  it("test 3 (agent_conversations) — lire la conversation de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.agentConversation.findUnique({ where: { id: agentConversationBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (agent_conversations) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.agentConversation.create({
          data: {
            tenantId: tenantB,
            employee: "compta",
            messages: [{ role: "user", content: "intrusion" }],
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (fec_imports) — withTenant(A) ne voit QUE les imports de A", async () => {
    const imports = await withTenant(tenantA, (tx) => tx.fecImport.findMany());
    expect(imports).toHaveLength(1);
    expect(imports[0]?.id).toBe(fecImportAId);
    expect(imports.some((i) => i.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (fec_imports) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const imports = await prisma.fecImport.findMany();
    expect(imports).toHaveLength(0);
  });

  it("test 3 (fec_imports) — lire l'import de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.fecImport.findUnique({ where: { id: fecImportBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (fec_imports) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.fecImport.create({
          data: {
            tenantId: tenantB,
            fileHash: "hash-intrusion",
            entryCount: 0,
            customerCount: 0,
            invoiceCount: 0,
            overdueCount: 0,
            overdueCents: 0,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (fec_invoices) — withTenant(A) ne voit QUE les factures de A", async () => {
    const invoices = await withTenant(tenantA, (tx) => tx.fecInvoice.findMany());
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.id).toBe(fecInvoiceAId);
    expect(invoices.some((i) => i.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (fec_invoices) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const invoices = await prisma.fecInvoice.findMany();
    expect(invoices).toHaveLength(0);
  });

  it("test 3 (fec_invoices) — lire la facture de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.fecInvoice.findUnique({ where: { id: fecInvoiceBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (fec_invoices) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.fecInvoice.create({
          data: {
            tenantId: tenantB,
            importId: fecImportBId,
            customerRef: "CLI-intrusion",
            number: "FA-intrusion",
            issuedDate: new Date("2026-01-01"),
            dueDate: new Date("2026-02-01"),
            amountCents: 100,
            residualCents: 100,
            settled: false,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (classeur_documents) — withTenant(A) ne voit QUE les documents de A", async () => {
    const documents = await withTenant(tenantA, (tx) => tx.classeurDocument.findMany());
    expect(documents).toHaveLength(1);
    expect(documents[0]?.id).toBe(classeurDocumentAId);
    expect(documents.some((d) => d.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (classeur_documents) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const documents = await prisma.classeurDocument.findMany();
    expect(documents).toHaveLength(0);
  });

  it("test 3 (classeur_documents) — lire le document de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.classeurDocument.findUnique({ where: { id: classeurDocumentBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (classeur_documents) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.classeurDocument.create({
          data: {
            tenantId: tenantB,
            fileName: "intrusion.jpg",
            mimeType: "image/jpeg",
            byteSize: 4,
            sha256: "hash-intrusion",
            photo: Buffer.from("intrusion"),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (stock_items) — withTenant(A) ne voit QUE les articles de A", async () => {
    const items = await withTenant(tenantA, (tx) => tx.stockItem.findMany());
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(stockItemAId);
    expect(items.some((i) => i.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (stock_items) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const items = await prisma.stockItem.findMany();
    expect(items).toHaveLength(0);
  });

  it("test 3 (stock_items) — lire l'article de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.stockItem.findUnique({ where: { id: stockItemBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (stock_items) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.stockItem.create({
          data: { tenantId: tenantB, name: "intrusion", quantity: 0, alertThreshold: 0 },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (stock_movements) — withTenant(A) ne voit QUE les mouvements de A", async () => {
    const movements = await withTenant(tenantA, (tx) => tx.stockMovement.findMany());
    expect(movements).toHaveLength(1);
    expect(movements[0]?.id).toBe(stockMovementAId);
    expect(movements.some((m) => m.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (stock_movements) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const movements = await prisma.stockMovement.findMany();
    expect(movements).toHaveLength(0);
  });

  it("test 3 (stock_movements) — lire le mouvement de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.stockMovement.findUnique({ where: { id: stockMovementBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (stock_movements) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.stockMovement.create({
          data: { tenantId: tenantB, itemId: stockItemBId, delta: -1, reason: "intrusion" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (push_subscriptions) — withTenant(A) ne voit QUE les abonnements de A", async () => {
    const subscriptions = await withTenant(tenantA, (tx) => tx.pushSubscription.findMany());
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.id).toBe(pushSubscriptionAId);
    expect(subscriptions.some((s) => s.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (push_subscriptions) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const subscriptions = await prisma.pushSubscription.findMany();
    expect(subscriptions).toHaveLength(0);
  });

  it("test 3 (push_subscriptions) — lire l'abonnement de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.pushSubscription.findUnique({ where: { id: pushSubscriptionBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (push_subscriptions) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.pushSubscription.create({
          data: {
            tenantId: tenantB,
            userId: tenantB,
            endpoint: "https://push.example.com/intrusion",
            p256dh: "p256dh-intrusion",
            auth: "auth-intrusion",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (push_dispatch_states) — withTenant(A) ne voit QUE l'état de A", async () => {
    const states = await withTenant(tenantA, (tx) => tx.pushDispatchState.findMany());
    expect(states).toHaveLength(1);
    expect(states[0]?.id).toBe(pushDispatchStateAId);
    expect(states.some((s) => s.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (push_dispatch_states) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const states = await prisma.pushDispatchState.findMany();
    expect(states).toHaveLength(0);
  });

  it("test 3 (push_dispatch_states) — lire l'état de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.pushDispatchState.findUnique({ where: { id: pushDispatchStateBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (push_dispatch_states) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.pushDispatchState.create({
          data: { tenantId: tenantB, userId: tenantB, category: "intrusion", pendingCount: 0 },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (fixed_assets) — withTenant(A) ne voit QUE les immobilisations de A", async () => {
    const assets = await withTenant(tenantA, (tx) => tx.fixedAsset.findMany());
    expect(assets).toHaveLength(1);
    expect(assets[0]?.id).toBe(fixedAssetAId);
    expect(assets.some((a) => a.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (fixed_assets) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const assets = await prisma.fixedAsset.findMany();
    expect(assets).toHaveLength(0);
  });

  it("test 3 (fixed_assets) — lire l'immobilisation de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.fixedAsset.findUnique({ where: { id: fixedAssetBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (fixed_assets) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.fixedAsset.create({
          data: {
            tenantId: tenantB,
            label: "intrusion",
            category: "informatique",
            inServiceDate: new Date("2025-03-01"),
            baseCents: 1000n,
            durationMonths: 12,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (staff_members) — withTenant(A) ne voit QUE les salariés de A", async () => {
    const members = await withTenant(tenantA, (tx) => tx.staffMember.findMany());
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe(staffMemberAId);
    expect(members.some((m) => m.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (staff_members) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const members = await prisma.staffMember.findMany();
    expect(members).toHaveLength(0);
  });

  it("test 3 (staff_members) — lire le salarié de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.staffMember.findUnique({ where: { id: staffMemberBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (staff_members) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.staffMember.create({
          data: { tenantId: tenantB, name: "intrusion", role: "intrus", weeklyHours: 35 },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (staff_absences) — withTenant(A) ne voit QUE les absences de A", async () => {
    const absences = await withTenant(tenantA, (tx) => tx.staffAbsence.findMany());
    expect(absences).toHaveLength(1);
    expect(absences[0]?.id).toBe(staffAbsenceAId);
    expect(absences.some((a) => a.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (staff_absences) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const absences = await prisma.staffAbsence.findMany();
    expect(absences).toHaveLength(0);
  });

  it("test 3 (staff_absences) — lire l'absence de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.staffAbsence.findUnique({ where: { id: staffAbsenceBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (staff_absences) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.staffAbsence.create({
          data: {
            tenantId: tenantB,
            staffId: staffMemberBId,
            type: "autre",
            startDate: new Date("2025-10-01"),
            endDate: new Date("2025-10-02"),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (tenant_profiles) — withTenant(A) ne voit QUE le profil de A", async () => {
    const profiles = await withTenant(tenantA, (tx) => tx.tenantProfile.findMany());
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe(tenantProfileAId);
    expect(profiles.some((p) => p.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (tenant_profiles) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const profiles = await prisma.tenantProfile.findMany();
    expect(profiles).toHaveLength(0);
  });

  it("test 3 (tenant_profiles) — lire le profil de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.tenantProfile.findUnique({ where: { id: tenantProfileBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (tenant_profiles) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.tenantProfile.create({
          data: { tenantId: tenantB, vertical: "negoce", headcountOverride: 1 },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (customer_reviews) — withTenant(A) ne voit QUE l'avis de A", async () => {
    const reviews = await withTenant(tenantA, (tx) => tx.customerReview.findMany());
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.id).toBe(customerReviewAId);
    expect(reviews.some((r) => r.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (customer_reviews) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const reviews = await prisma.customerReview.findMany();
    expect(reviews).toHaveLength(0);
  });

  it("test 3 (customer_reviews) — lire l'avis de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.customerReview.findUnique({ where: { id: customerReviewBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (customer_reviews) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.customerReview.create({
          data: {
            tenantId: tenantB,
            source: "manuel",
            rating: 3,
            text: "avis volé",
            reviewedAt: new Date("2025-09-03"),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (processing_activities) — withTenant(A) ne voit QUE le traitement de A", async () => {
    const activities = await withTenant(tenantA, (tx) => tx.processingActivity.findMany());
    expect(activities).toHaveLength(1);
    expect(activities[0]?.id).toBe(processingActivityAId);
    expect(activities.some((a) => a.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (processing_activities) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const activities = await prisma.processingActivity.findMany();
    expect(activities).toHaveLength(0);
  });

  it("test 3 (processing_activities) — lire le traitement de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.processingActivity.findUnique({ where: { id: processingActivityBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (processing_activities) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.processingActivity.create({
          data: {
            tenantId: tenantB,
            name: "Traitement volé",
            purpose: "vol",
            legalBasis: "consentement",
            dataCategories: ["identite"],
            dataSubjects: ["clients"],
            retention: "1 an",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (webhook_endpoints) — withTenant(A) ne voit QUE l'endpoint de A", async () => {
    const endpoints = await withTenant(tenantA, (tx) => tx.webhookEndpoint.findMany());
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.id).toBe(webhookEndpointAId);
    expect(endpoints.some((e) => e.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (webhook_endpoints) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const endpoints = await prisma.webhookEndpoint.findMany();
    expect(endpoints).toHaveLength(0);
  });

  it("test 3 (webhook_endpoints) — lire l'endpoint de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.webhookEndpoint.findUnique({ where: { id: webhookEndpointBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (webhook_endpoints) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.webhookEndpoint.create({
          data: { tenantId: tenantB, provider: "pdp", secretRef: "vole" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (webhook_events) — withTenant(A) ne voit QUE l'événement de A", async () => {
    const events = await withTenant(tenantA, (tx) => tx.webhookEvent.findMany());
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(webhookEventAId);
    expect(events.some((e) => e.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (webhook_events) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const events = await prisma.webhookEvent.findMany();
    expect(events).toHaveLength(0);
  });

  it("test 3 (webhook_events) — lire l'événement de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.webhookEvent.findUnique({ where: { id: webhookEventBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (webhook_events) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.webhookEvent.create({
          data: {
            tenantId: tenantB,
            endpointId: webhookEndpointBId,
            provider: "test",
            externalId: "evt-vole",
            payload: { hello: "vole" },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (einvoice_submissions) — withTenant(A) ne voit QUE la soumission de A", async () => {
    const submissions = await withTenant(tenantA, (tx) => tx.eInvoiceSubmission.findMany());
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.id).toBe(einvoiceSubmissionAId);
    expect(submissions.some((s) => s.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (einvoice_submissions) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const submissions = await prisma.eInvoiceSubmission.findMany();
    expect(submissions).toHaveLength(0);
  });

  it("test 3 (einvoice_submissions) — lire la soumission de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.eInvoiceSubmission.findUnique({ where: { id: einvoiceSubmissionBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (einvoice_submissions) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.eInvoiceSubmission.create({
          data: {
            tenantId: tenantB,
            invoiceNumber: "FA-intrusion",
            profile: "BASIC",
            documentHash: "hash-intrusion",
            amountCents: 100,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("test 1 (tax_deadlines) — withTenant(A) ne voit QUE l'échéance de A", async () => {
    const deadlines = await withTenant(tenantA, (tx) => tx.taxDeadline.findMany());
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]?.id).toBe(taxDeadlineAId);
    expect(deadlines.some((d) => d.tenantId === tenantB)).toBe(false);
  });

  it("test 2 (tax_deadlines) — sans contexte tenant, aucune ligne (la RLS bloque, sans erreur)", async () => {
    const deadlines = await prisma.taxDeadline.findMany();
    expect(deadlines).toHaveLength(0);
  });

  it("test 3 (tax_deadlines) — lire l'échéance de B par son id depuis le contexte A renvoie vide", async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.taxDeadline.findUnique({ where: { id: taxDeadlineBId } }),
    );
    expect(stolen).toBeNull();
  });

  it("test 3bis (tax_deadlines) — écrire dans le tenant B depuis le contexte A est rejeté (WITH CHECK)", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.taxDeadline.create({
          data: {
            tenantId: tenantB,
            obligationId: "intrusion",
            dueDate: new Date("2026-10-01"),
            status: "prevu",
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("preuve — la protection vient de la RLS, pas d'un WHERE applicatif", () => {
  it("policy désactivée => la fuite se produit (donc les tests ci-dessus reposent bien sur la RLS)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "notes" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.note.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((n) => n.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.note.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "notes" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const notes = await withTenant(tenantA, (tx) => tx.note.findMany());
    expect(notes).toHaveLength(1);
  });

  it("policy désactivée sur classifications => la fuite se produit aussi (audit RGPD non protégé sans RLS)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "classifications" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.classification.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((c) => c.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.classification.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "classifications" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "classifications" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const classifications = await withTenant(tenantA, (tx) => tx.classification.findMany());
    expect(classifications).toHaveLength(1);
  });

  it("policy désactivée sur tenant_policies => la fuite se produit aussi (la table qui pilote l'opt-in frontier)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "tenant_policies" DISABLE ROW LEVEL SECURITY`);
    try {
      const leaked = await withTenant(tenantA, (tx) => tx.tenantPolicy.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((p) => p.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.tenantPolicy.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "tenant_policies" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "tenant_policies" FORCE ROW LEVEL SECURITY`);
    }

    const policies = await withTenant(tenantA, (tx) => tx.tenantPolicy.findMany());
    expect(policies).toHaveLength(1);
  });

  it("policy désactivée sur connectors => la fuite se produit aussi (les credentials_ref des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "connectors" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.connector.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((c) => c.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.connector.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "connectors" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "connectors" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const connectors = await withTenant(tenantA, (tx) => tx.connector.findMany());
    expect(connectors).toHaveLength(1);
  });

  it("policy désactivée sur documents => la fuite se produit aussi", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.document.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((d) => d.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.document.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "documents" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const documents = await withTenant(tenantA, (tx) => tx.document.findMany());
    expect(documents).toHaveLength(1);
  });

  it("policy désactivée sur document_chunks => la fuite se produit aussi (le contenu vectorisé des deux tenants devient visible)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "document_chunks" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.documentChunk.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((c) => c.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.documentChunk.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "document_chunks" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const chunks = await withTenant(tenantA, (tx) => tx.documentChunk.findMany());
    expect(chunks).toHaveLength(1);
  });

  it("policy désactivée sur pending_actions => la fuite se produit aussi (la file de validation human-in-the-loop devient visible entre tenants)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "pending_actions" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.pendingAction.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((p) => p.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.pendingAction.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "pending_actions" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "pending_actions" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const pendingActions = await withTenant(tenantA, (tx) => tx.pendingAction.findMany());
    expect(pendingActions).toHaveLength(1);
  });

  it("policy désactivée sur agent_conversations => la fuite se produit aussi (les transcripts des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "agent_conversations" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.agentConversation.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((c) => c.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.agentConversation.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "agent_conversations" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "agent_conversations" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const conversations = await withTenant(tenantA, (tx) => tx.agentConversation.findMany());
    expect(conversations).toHaveLength(1);
  });

  it("policy désactivée sur fec_imports => la fuite se produit aussi (données CONFIDENTIELLES dérivées du journal comptable)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "fec_imports" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.fecImport.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((i) => i.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.fecImport.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "fec_imports" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "fec_imports" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const imports = await withTenant(tenantA, (tx) => tx.fecImport.findMany());
    expect(imports).toHaveLength(1);
  });

  it("policy désactivée sur fec_invoices => la fuite se produit aussi (données CONFIDENTIELLES dérivées du journal comptable)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "fec_invoices" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.fecInvoice.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((i) => i.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.fecInvoice.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "fec_invoices" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "fec_invoices" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const invoices = await withTenant(tenantA, (tx) => tx.fecInvoice.findMany());
    expect(invoices).toHaveLength(1);
  });

  it("policy désactivée sur classeur_documents => la fuite se produit aussi (les photos de justificatifs des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "classeur_documents" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.classeurDocument.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((d) => d.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.classeurDocument.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "classeur_documents" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "classeur_documents" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const documents = await withTenant(tenantA, (tx) => tx.classeurDocument.findMany());
    expect(documents).toHaveLength(1);
  });

  it("policy désactivée sur stock_items => la fuite se produit aussi (les niveaux de stock des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "stock_items" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.stockItem.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((i) => i.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.stockItem.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "stock_items" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "stock_items" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const items = await withTenant(tenantA, (tx) => tx.stockItem.findMany());
    expect(items).toHaveLength(1);
  });

  it("policy désactivée sur stock_movements => la fuite se produit aussi (le journal APPEND-ONLY des mouvements des deux tenants devient visible)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "stock_movements" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.stockMovement.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((m) => m.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.stockMovement.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const movements = await withTenant(tenantA, (tx) => tx.stockMovement.findMany());
    expect(movements).toHaveLength(1);
  });

  it("policy désactivée sur push_subscriptions => la fuite se produit aussi (les clés Web Push des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "push_subscriptions" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.pushSubscription.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((s) => s.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.pushSubscription.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const subscriptions = await withTenant(tenantA, (tx) => tx.pushSubscription.findMany());
    expect(subscriptions).toHaveLength(1);
  });

  it("policy désactivée sur push_dispatch_states => la fuite se produit aussi (l'état de regroupement anti-spam des deux tenants devient visible)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "push_dispatch_states" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.pushDispatchState.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((s) => s.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.pushDispatchState.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "push_dispatch_states" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "push_dispatch_states" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const states = await withTenant(tenantA, (tx) => tx.pushDispatchState.findMany());
    expect(states).toHaveLength(1);
  });

  it("policy désactivée sur fixed_assets => la fuite se produit aussi (le registre des immobilisations des deux tenants devient visible)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "fixed_assets" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.fixedAsset.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((a) => a.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.fixedAsset.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "fixed_assets" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "fixed_assets" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const assets = await withTenant(tenantA, (tx) => tx.fixedAsset.findMany());
    expect(assets).toHaveLength(1);
  });

  it("policy désactivée sur staff_members => la fuite se produit aussi (le référentiel des salariés des deux tenants devient visible)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "staff_members" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.staffMember.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((m) => m.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.staffMember.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "staff_members" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "staff_members" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const members = await withTenant(tenantA, (tx) => tx.staffMember.findMany());
    expect(members).toHaveLength(1);
  });

  it("policy désactivée sur staff_absences => la fuite se produit aussi (les absences des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "staff_absences" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.staffAbsence.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((a) => a.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.staffAbsence.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "staff_absences" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "staff_absences" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const absences = await withTenant(tenantA, (tx) => tx.staffAbsence.findMany());
    expect(absences).toHaveLength(1);
  });

  it("policy désactivée sur tenant_profiles => la fuite se produit aussi (secteur/effectif des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "tenant_profiles" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.tenantProfile.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((p) => p.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.tenantProfile.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "tenant_profiles" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "tenant_profiles" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const profiles = await withTenant(tenantA, (tx) => tx.tenantProfile.findMany());
    expect(profiles).toHaveLength(1);
  });

  it("policy désactivée sur customer_reviews => la fuite se produit aussi (avis des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "customer_reviews" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.customerReview.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((r) => r.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.customerReview.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "customer_reviews" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "customer_reviews" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const reviews = await withTenant(tenantA, (tx) => tx.customerReview.findMany());
    expect(reviews).toHaveLength(1);
  });

  it("policy désactivée sur processing_activities => la fuite se produit aussi (traitements des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "processing_activities" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.processingActivity.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((a) => a.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.processingActivity.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "processing_activities" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "processing_activities" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const activities = await withTenant(tenantA, (tx) => tx.processingActivity.findMany());
    expect(activities).toHaveLength(1);
  });

  it("policy désactivée sur webhook_endpoints => la fuite se produit aussi (endpoints des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "webhook_endpoints" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.webhookEndpoint.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((e) => e.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.webhookEndpoint.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const endpoints = await withTenant(tenantA, (tx) => tx.webhookEndpoint.findMany());
    expect(endpoints).toHaveLength(1);
  });

  it("policy désactivée sur webhook_events => la fuite se produit aussi (événements des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "webhook_events" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.webhookEvent.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((e) => e.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.webhookEvent.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const events = await withTenant(tenantA, (tx) => tx.webhookEvent.findMany());
    expect(events).toHaveLength(1);
  });

  it("policy désactivée sur einvoice_submissions => la fuite se produit aussi (suivi de dépôt des deux tenants devient visible)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "einvoice_submissions" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.eInvoiceSubmission.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((s) => s.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.eInvoiceSubmission.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "einvoice_submissions" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "einvoice_submissions" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const submissions = await withTenant(tenantA, (tx) => tx.eInvoiceSubmission.findMany());
    expect(submissions).toHaveLength(1);
  });

  it("policy désactivée sur tax_deadlines => la fuite se produit aussi (les surcharges des deux tenants deviennent visibles)", async () => {
    await admin.$executeRawUnsafe(`ALTER TABLE "tax_deadlines" DISABLE ROW LEVEL SECURITY`);
    try {
      // Les requêtes applicatives n'ont AUCUN filtre tenant : sans RLS, tout fuit.
      const leaked = await withTenant(tenantA, (tx) => tx.taxDeadline.findMany());
      expect(leaked.length).toBe(2);
      expect(leaked.some((d) => d.tenantId === tenantB)).toBe(true);

      const leakedNoContext = await prisma.taxDeadline.findMany();
      expect(leakedNoContext.length).toBe(2);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "tax_deadlines" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "tax_deadlines" FORCE ROW LEVEL SECURITY`);
    }

    // Et une fois la RLS réactivée, l'isolation revient.
    const deadlines = await withTenant(tenantA, (tx) => tx.taxDeadline.findMany());
    expect(deadlines).toHaveLength(1);
  });
});
