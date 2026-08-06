import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import type { PrismaClient } from "@prisma/client";
import { assertNoBusinessData, emitOutbox, OutboxContentError } from "../src/outbox.js";

/*
 * Bus d'événements (4.4, PR A) — l'ATOMICITÉ et la MINIMISATION.
 *
 * Les deux propriétés sont indissociables du choix de l'outbox, et toutes deux
 * échouent en silence si on les perd : un événement manquant laisse les écrans
 * mentir jusqu'au rechargement suivant, un événement de trop déclenche une
 * relance pour un travail qui n'a jamais été enregistré.
 */

let admin: PrismaClient;
let tenantA: string;
let tenantB: string;
const RUN = Date.now().toString(36);

beforeAll(async () => {
  admin = createAdminClient();
  const a = await admin.tenant.create({ data: { name: `Outbox A ${RUN}`, slug: `ob-a-${RUN}` } });
  const b = await admin.tenant.create({ data: { name: `Outbox B ${RUN}`, slug: `ob-b-${RUN}` } });
  tenantA = a.id;
  tenantB = b.id;
}, 60_000);

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const count = (tenantId: string): Promise<number> =>
  withTenant(tenantId, (tx) => tx.outboxEvent.count());

describe("l'événement est atomique avec l'écriture métier", () => {
  it("une écriture réussie produit EXACTEMENT un événement", async () => {
    const avant = await count(tenantA);
    await withTenant(tenantA, async (tx) => {
      await tx.note.create({ data: { tenantId: tenantA, title: `note ${RUN}`, body: "x" } });
      await emitOutbox(tx, tenantA, { type: "affaire.modifiee", objectType: "note" });
    });
    expect(await count(tenantA)).toBe(avant + 1);
  });

  it("une transaction ANNULÉE ne produit AUCUN événement", async () => {
    /*
     * Le bug que l'outbox existe pour rendre impossible. Un `emit()` posé
     * avant le commit — ou une file appelée dans la foulée — déclencherait ici
     * une relance pour un travail qui n'a jamais été enregistré. L'événement
     * vit dans la MÊME transaction : le rollback l'emporte.
     */
    const avant = await count(tenantA);
    await expect(
      withTenant(tenantA, async (tx) => {
        await tx.note.create({ data: { tenantId: tenantA, title: `annulée ${RUN}`, body: "x" } });
        await emitOutbox(tx, tenantA, { type: "affaire.modifiee", objectType: "note" });
        throw new Error("échec métier après émission");
      }),
    ).rejects.toThrow("échec métier");
    expect(await count(tenantA)).toBe(avant);
  });

  it("un événement naît À RELAYER, jamais déjà transmis", async () => {
    // `deliveredAt` posé à la création ferait sauter l'événement au relais :
    // écrit, jamais transmis, et parfaitement invisible.
    await withTenant(tenantA, (tx) =>
      emitOutbox(tx, tenantA, { type: "contrat.modifie", objectType: "contrat" }),
    );
    const dernier = await withTenant(tenantA, (tx) =>
      tx.outboxEvent.findFirst({ orderBy: { occurredAt: "desc" } }),
    );
    expect(dernier?.deliveredAt).toBeNull();
  });
});

describe("un événement ne transporte AUCUNE donnée métier", () => {
  it("une paire nom/valeur glissée dans changedFields est REFUSÉE", () => {
    /*
     * Le piège n'est pas la malice, c'est la distraction : on pousse
     * `clientName: "Dupont"` en croyant décrire un champ. La donnée finirait
     * dans les files, les journaux et les rejeux — et serait périmée au moment
     * où quelqu'un la lit.
     */
    expect(() =>
      assertNoBusinessData({
        type: "affaire.modifiee",
        objectType: "affaire",
        changedFields: ["statut:TERMINEE"],
      }),
    ).toThrow(OutboxContentError);
  });

  it("un nom de champ qui trahit une donnée sensible est REFUSÉ", () => {
    // Le NOM seul suffit à faire du mal : « clientName » dans un journal dit
    // déjà qu'on parle de l'identité de quelqu'un.
    for (const champ of ["clientName", "quotedAmountCents", "email", "adresse"]) {
      expect(() =>
        assertNoBusinessData({
          type: "affaire.modifiee",
          objectType: "affaire",
          changedFields: [champ],
        }),
      ).toThrow(OutboxContentError);
    }
  });

  it("des noms de champs ANODINS passent — la garde n'interdit pas de décrire", () => {
    expect(() =>
      assertNoBusinessData({
        type: "affaire.modifiee",
        objectType: "affaire",
        changedFields: ["status", "startDate"],
      }),
    ).not.toThrow();
  });

  it("un type qui ne périme AUCUNE vue est refusé", () => {
    /*
     * Sans cette garde, l'événement serait écrit, relayé, et n'aurait aucun
     * effet : un silence, pas une erreur — donc impossible à remarquer. C'est
     * exactement la panne de fraîcheur, déplacée d'un cran.
     */
    expect(() =>
      assertNoBusinessData({
        type: "evenement.inconnu" as never,
        objectType: "affaire",
      }),
    ).toThrow(OutboxContentError);
  });

  it("la garde s'applique à l'ÉCRITURE, pas seulement au contrôle", async () => {
    // Une garde qu'on peut contourner en appelant `emitOutbox` directement
    // n'est pas une garde.
    await expect(
      withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, {
          type: "affaire.modifiee",
          objectType: "affaire",
          changedFields: ["clientName"],
        }),
      ),
    ).rejects.toThrow(OutboxContentError);
  });
});

describe("isolation", () => {
  it("un tenant ne voit jamais les événements d'un autre", async () => {
    await withTenant(tenantB, (tx) =>
      emitOutbox(tx, tenantB, { type: "stock.modifie", objectType: "stock_item" }),
    );
    const vusDeA = await withTenant(tenantA, (tx) =>
      tx.outboxEvent.findMany({ where: { type: "stock.modifie" } }),
    );
    expect(vusDeA).toHaveLength(0);
    const vusDeB = await withTenant(tenantB, (tx) =>
      tx.outboxEvent.findMany({ where: { type: "stock.modifie" } }),
    );
    expect(vusDeB.length).toBeGreaterThanOrEqual(1);
  });

  it("PREUVE : sans la policy, la fuite a bien lieu", async () => {
    /*
     * Le test d'isolation ci-dessus doit échouer si quelqu'un retire la
     * policy. On le prouve en la désactivant ici — sans quoi il pourrait être
     * vert pour une tout autre raison (un filtre applicatif, par exemple).
     */
    await admin.$executeRawUnsafe(`ALTER TABLE "outbox" DISABLE ROW LEVEL SECURITY`);
    try {
      const fuite = await withTenant(tenantA, (tx) =>
        tx.outboxEvent.findMany({ where: { type: "stock.modifie" } }),
      );
      expect(fuite.length).toBeGreaterThanOrEqual(1);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY`);
    }
  });
});
