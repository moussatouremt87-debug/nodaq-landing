import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant, nextAffaireReference } from "../src/index.js";
import { createAdminClient } from "../src/admin.js";

/*
 * Référence d'affaire sous CONCURRENCE (ticket 4.1, critère d'acceptation).
 *
 * Le ticket demande vingt créations parallèles sur le même tenant et vingt
 * références distinctes. Ce test échoue avec l'implémentation naïve
 * (`count() + 1`), ce qui est exactement son intérêt : il ne vérifie pas que le
 * code marche, il vérifie que la SEULE implémentation qui marche est utilisée.
 */

const PARALLEL = 20;

let admin: PrismaClient;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createAdminClient();
  await admin.affaireImputation.deleteMany();
  await admin.affaire.deleteMany();
  await admin.affaireCounter.deleteMany();
  await admin.tenant.deleteMany({ where: { slug: { startsWith: "aff-ref-" } } });
  const a = await admin.tenant.create({ data: { name: "Ref A", slug: "aff-ref-a" } });
  const b = await admin.tenant.create({ data: { name: "Ref B", slug: "aff-ref-b" } });
  tenantA = a.id;
  tenantB = b.id;
});

afterAll(async () => {
  await admin.affaireImputation.deleteMany();
  await admin.affaire.deleteMany();
  await admin.affaireCounter.deleteMany();
  await admin.tenant.deleteMany({ where: { slug: { startsWith: "aff-ref-" } } });
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("référence d'affaire", () => {
  it(`${PARALLEL} créations PARALLÈLES sur le même tenant => ${PARALLEL} références distinctes`, async () => {
    const created = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        withTenant(tenantA, async (tx) => {
          const reference = await nextAffaireReference(tx, tenantA, 2026);
          return tx.affaire.create({
            data: { tenantId: tenantA, reference, label: `Chantier ${index}` },
          });
        }),
      ),
    );

    const references = created.map((affaire) => affaire.reference);
    expect(new Set(references).size).toBe(PARALLEL);
    // Numérotation continue : pas de trou quand tout réussit.
    expect([...references].sort()).toEqual(
      Array.from({ length: PARALLEL }, (_, i) => `2026-${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("les compteurs sont PAR TENANT : le voisin ne décale pas votre numérotation", async () => {
    // Un compteur global ferait sauter les références d'un artisan parce qu'un
    // autre client du produit a créé des chantiers le même jour. Illisible pour
    // lui, et impossible à expliquer.
    const first = await withTenant(tenantB, async (tx) => {
      const reference = await nextAffaireReference(tx, tenantB, 2026);
      return tx.affaire.create({ data: { tenantId: tenantB, reference, label: "Premier" } });
    });
    expect(first.reference).toBe("2026-001");
  });

  it("le compteur est PAR ANNÉE : on repart à 001 en janvier", async () => {
    const reference = await withTenant(tenantB, (tx) => nextAffaireReference(tx, tenantB, 2027));
    expect(reference).toBe("2027-001");
  });

  it("une création annulée REND son numéro : pas de trou, et toujours pas de collision", async () => {
    // Le compteur est une LIGNE, pas une séquence : il est annulé avec la
    // transaction qui l'a incrémenté. On gagne une numérotation continue —
    // « 2026-013 puis 2026-015 » se remarque et se fait expliquer — sans rien
    // céder sur les doublons, que le verrou de ligne empêche (test ci-dessus).
    //
    // Le prix, assumé : les créations d'un même tenant se sérialisent le temps
    // d'une transaction. À trois chantiers par semaine, ça ne se voit pas.
    const before = await withTenant(tenantB, (tx) => nextAffaireReference(tx, tenantB, 2028));
    await withTenant(tenantB, async (tx) => {
      await nextAffaireReference(tx, tenantB, 2028);
      throw new Error("rollback volontaire");
    }).catch(() => undefined);
    const after = await withTenant(tenantB, (tx) => nextAffaireReference(tx, tenantB, 2028));
    expect(before).toBe("2028-001");
    expect(after).toBe("2028-002");
  });

  it("l'unicité (tenant, référence) reste le dernier rempart si on contourne le compteur", async () => {
    await withTenant(tenantA, (tx) =>
      tx.affaire.create({ data: { tenantId: tenantA, reference: "9999-001", label: "Manuelle" } }),
    );
    await expect(
      withTenant(tenantA, (tx) =>
        tx.affaire.create({
          data: { tenantId: tenantA, reference: "9999-001", label: "Doublon" },
        }),
      ),
    ).rejects.toThrow();
  });
});
