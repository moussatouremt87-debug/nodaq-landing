import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant, withWebhookResolver } from "../src/index.js";
import { createAdminClient } from "../src/admin.js";

/*
 * Défense en profondeur de la porte de résolution webhook (ticket 2.13) : une
 * requête webhook entrante n'a AUCUNE session applicative, donc aucun tenant
 * connu — withWebhookResolver() est la SEULE façon de retrouver l'endpoint
 * (et donc le tenant) avant de pouvoir ouvrir withTenant(). Hors de cette
 * porte, `webhook_endpoints` est une table VIDE, comme n'importe quelle table
 * métier hors withTenant. La porte NE donne PAS accès à `webhook_events` :
 * cette table reste scellée derrière la policy tenant_isolation normale.
 */

let admin: PrismaClient;
let tenantId: string;
let endpointId: string;

const RUN = Date.now().toString(36);

beforeAll(async () => {
  admin = createAdminClient();
  const tenant = await admin.tenant.create({ data: { name: `Webhook Resolver Tenant ${RUN}` } });
  tenantId = tenant.id;

  const endpoint = await withTenant(tenantId, (tx) =>
    tx.webhookEndpoint.create({
      data: { tenantId, provider: "test", secretRef: `secret-ref-${RUN}` },
    }),
  );
  endpointId = endpoint.id;

  await withTenant(tenantId, (tx) =>
    tx.webhookEvent.create({
      data: {
        tenantId,
        endpointId,
        provider: "test",
        externalId: `evt-${RUN}`,
        payload: { hello: "resolver" },
      },
    }),
  );
});

afterAll(async () => {
  await admin.webhookEvent.deleteMany({ where: { tenantId } });
  await admin.webhookEndpoint.deleteMany({ where: { tenantId } });
  await admin.tenant.delete({ where: { id: tenantId } });
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("porte de résolution webhook — rempart app.webhook_resolver", () => {
  it("hors withWebhookResolver : webhook_endpoints est vide, comme toute table métier hors contexte", async () => {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { id: endpointId } });
    expect(endpoints).toHaveLength(0);
  });

  it("sous withWebhookResolver : la résolution par id fonctionne", async () => {
    const resolved = await withWebhookResolver((tx) =>
      tx.webhookEndpoint.findUnique({ where: { id: endpointId } }),
    );
    expect(resolved?.id).toBe(endpointId);
    expect(resolved?.tenantId).toBe(tenantId);
  });

  it("sous withWebhookResolver : webhook_events reste inaccessible (la porte ne couvre QUE webhook_endpoints)", async () => {
    const events = await withWebhookResolver((tx) => tx.webhookEvent.findMany({ where: { tenantId } }));
    expect(events).toHaveLength(0);
  });

  it("le chemin légitime : résoudre l'endpoint, puis basculer sur withTenant pour voir l'événement", async () => {
    const resolved = await withWebhookResolver((tx) =>
      tx.webhookEndpoint.findUnique({ where: { id: endpointId } }),
    );
    expect(resolved).not.toBeNull();

    const events = await withTenant(resolved!.tenantId, (tx) =>
      tx.webhookEvent.findMany({ where: { endpointId } }),
    );
    expect(events).toHaveLength(1);
  });
});
