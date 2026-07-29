import { afterAll, describe, expect, it } from "vitest";
import { prisma, withOps } from "../src/index.js";

/*
 * Défense en profondeur du schéma ops (audit 2.18) : les tables support ne
 * sont accessibles qu'à travers withOps() — un accès direct sous app_user
 * (celui du code tenant, des outils MCP, de l'agent-runtime) voit une table
 * VIDE et ne peut pas écrire. Le test échoue si la policy saute.
 */

const RUN = Date.now().toString(36);

afterAll(async () => {
  await withOps((tx) => tx.supportTicket.deleteMany({ where: { fromEmail: { contains: RUN } } }));
  await prisma.$disconnect();
});

describe("schéma ops — rempart app.ops_operator", () => {
  it("hors withOps : lecture vide, écriture refusée ; sous withOps : accès normal", async () => {
    const ticket = await withOps((tx) =>
      tx.supportTicket.create({
        data: { messageId: `<ops-test-${RUN}@test>`, fromEmail: `ops-${RUN}@example.com` },
      }),
    );

    // Accès direct (le chemin qu'emprunterait du code tenant dévoyé) : RIEN.
    expect(
      await prisma.supportTicket.findMany({ where: { id: ticket.id } }),
    ).toHaveLength(0);
    await expect(
      prisma.supportTicket.create({
        data: { messageId: `<ops-forge-${RUN}@test>`, fromEmail: `forge-${RUN}@example.com` },
      }),
    ).rejects.toThrow();

    // Le chemin légitime voit la ligne.
    const seen = await withOps((tx) => tx.supportTicket.findUnique({ where: { id: ticket.id } }));
    expect(seen?.id).toBe(ticket.id);
  });
});
