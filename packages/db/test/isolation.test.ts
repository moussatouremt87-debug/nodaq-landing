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
});
