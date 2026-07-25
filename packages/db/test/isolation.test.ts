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

beforeAll(async () => {
  admin = createAdminClient();
  await admin.note.deleteMany();
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
});
