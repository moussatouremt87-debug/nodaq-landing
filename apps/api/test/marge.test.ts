import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Marge (2.8). Le danger est ASYMÉTRIQUE : une charge oubliée fait toujours
 * paraître la marge meilleure. Ce qui est testé côté API : que le produit
 * n'affiche JAMAIS un pourcentage de marge comme un résultat tant qu'un poste
 * manque, et que la donnée (CA + masse salariale agrégée) reste owner-only.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgId: string;

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

/** Dernier mois COMPLET (UTC) — le défaut de la route. */
function lastCompleteMonth(): string {
  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`marge-owner-${RUN}@example.com`, "Marge Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Marge ${RUN}`, slug: `org-marge-${RUN}` },
  });
  orgId = org.json().id as string;

  memberCookie = await signup(`marge-member-${RUN}@example.com`, "Marge Member");
  const memberId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: memberCookie } })
  ).json().userId as string;
  await admin.membership.create({ data: { tenantId: orgId, userId: memberId, role: "member" } });
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: memberCookie },
    payload: { organizationId: orgId },
  });

  // Facturier démo : 12 mois d'historique payé, zéro réseau.
  await withTenant(orgId, (tx) =>
    tx.connector.upsert({
      where: { tenantId_type: { tenantId: orgId, type: "pennylane" } },
      update: { status: "demo" },
      create: {
        tenantId: orgId,
        type: "pennylane",
        status: "demo",
        credentialsRef: `connector/${orgId}/pennylane`,
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("marge — owner-only", () => {
  it("un membre n'accède ni à la marge ni aux charges : 403", async () => {
    for (const url of ["/marge", "/marge/charges?month=2026-06"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: memberCookie } });
      expect(res.statusCode).toBe(403);
    }
    const write = await app.inject({
      method: "PUT",
      url: "/marge/charges",
      headers: { cookie: memberCookie },
      payload: { month: "2026-06", category: "achats", amountCents: 1000 },
    });
    expect(write.statusCode).toBe(403);
  });

  it("anonyme : 401", async () => {
    expect((await app.inject({ method: "GET", url: "/marge" })).statusCode).toBe(401);
  });
});

describe("base incomplète : une BORNE, jamais un pourcentage affirmé", () => {
  it("sans aucune charge, chaque niveau est une borne supérieure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/marge",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json() as {
      month: string;
      levels: { kind: string; reason: string; missingCategories: string[] }[];
      missingCategories: { id: string }[];
      label: string;
    };
    expect(body.month).toBe(lastCompleteMonth());
    expect(body.levels.length).toBeGreaterThan(0);
    for (const level of body.levels) {
      expect(level.kind).toBe("borne_superieure");
      expect(level.reason).toContain("AU PLUS");
      expect(level.missingCategories.length).toBeGreaterThan(0);
    }
    // Les six postes sont nommés : aucun n'est supposé à zéro.
    expect(body.missingCategories).toHaveLength(6);
    expect(body.label).toContain("meilleure qu'elle n'est");
  });

  it("saisir une charge la retire des postes manquants et abaisse la borne", async () => {
    const month = lastCompleteMonth();
    const before = (await app.inject({
      method: "GET",
      url: "/marge",
      headers: { cookie: ownerCookie },
    })).json() as { levels: { level: string; marginCents: number }[] };

    const saved = await app.inject({
      method: "PUT",
      url: "/marge/charges",
      headers: { cookie: ownerCookie },
      payload: { month, category: "achats", amountCents: 250_000 },
    });
    expect(saved.statusCode).toBe(200);

    const after = (await app.inject({
      method: "GET",
      url: "/marge",
      headers: { cookie: ownerCookie },
    })).json() as {
      levels: { level: string; marginCents: number }[];
      missingCategories: { id: string }[];
    };
    const beforeDirect = before.levels.find((l) => l.level === "direct")?.marginCents ?? 0;
    const afterDirect = after.levels.find((l) => l.level === "direct")?.marginCents ?? 0;
    expect(afterDirect).toBe(beforeDirect - 250_000);
    expect(after.missingCategories.map((c) => c.id)).not.toContain("achats");
  });

  it("le mois EN COURS est refusé : ses charges ne sont pas encore là", async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const res = await app.inject({
      method: "GET",
      url: `/marge?month=${current}`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as { refused?: boolean; reason?: string };
    expect(body.refused).toBe(true);
    // C'est le piège propre à la marge : le CA arrive avant ses charges.
    expect(body.reason).toContain("trop belle");
  });

  it("mois malformé : 400 net", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/marge?month=2026-13",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("charges : provenance et priorité", () => {
  it("une saisie humaine n'écrase pas une charge dérivée du FEC, et inversement", async () => {
    const month = "2026-03";
    await withTenant(orgId, (tx) =>
      tx.costEntry.create({
        data: { tenantId: orgId, month, category: "achats", amountCents: 100_000, source: "fec" },
      }),
    );
    const saved = await app.inject({
      method: "PUT",
      url: "/marge/charges",
      headers: { cookie: ownerCookie },
      payload: { month, category: "achats", amountCents: 40_000 },
    });
    expect(saved.statusCode).toBe(200);

    const listed = (await app.inject({
      method: "GET",
      url: `/marge/charges?month=${month}`,
      headers: { cookie: ownerCookie },
    })).json() as { costs: { category: string; amountCents: number; source: string }[] };
    const achats = listed.costs.filter((cost) => cost.category === "achats");
    // Deux lignes distinctes : la saisie complète l'import, elle ne le nie pas.
    expect(achats).toHaveLength(2);
    expect(achats.map((cost) => cost.source).sort()).toEqual(["fec", "saisi"]);
  });

  it("une charge dérivée du FEC ne se supprime pas à la main : 409", async () => {
    const derived = await withTenant(orgId, (tx) =>
      tx.costEntry.create({
        data: {
          tenantId: orgId,
          month: "2026-02",
          category: "main_oeuvre",
          amountCents: 300_000,
          source: "fec",
        },
        select: { id: true },
      }),
    );
    const res = await app.inject({
      method: "DELETE",
      url: `/marge/charges/${derived.id}`,
      headers: { cookie: ownerCookie },
    });
    // Sinon la marge remonterait sans que personne sache pourquoi.
    expect(res.statusCode).toBe(409);
  });

  it("un poste hors catalogue est refusé : 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/marge/charges",
      headers: { cookie: ownerCookie },
      payload: { month: "2026-06", category: "poste_invente", amountCents: 1000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("les charges d'un autre tenant restent invisibles", async () => {
    const otherCookie = await signup(`marge-autre-${RUN}@example.com`, "Marge Autre");
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: otherCookie },
      payload: { name: `Org Marge B ${RUN}`, slug: `org-marge-b-${RUN}` },
    });
    const listed = (await app.inject({
      method: "GET",
      url: "/marge/charges?month=2026-03",
      headers: { cookie: otherCookie },
    })).json() as { costs: unknown[] };
    expect(listed.costs).toEqual([]);
  });
});
