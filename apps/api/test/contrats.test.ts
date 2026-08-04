import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Contrats récurrents (4.2, bloc 2).
 *
 * Le moteur de récurrence est testé à part, en pur (`@nodaq/shared`). Ici on
 * éprouve ce que le moteur ne peut pas voir : l'autorisation, l'idempotence
 * réelle en base, et surtout que MATÉRIALISER ne mente pas sur l'argent.
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

/** Contrat mensuel démarré il y a longtemps : trois échéances dues. */
async function createContrat(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/contrats",
    headers: { cookie: ownerCookie },
    payload: {
      label: "Entretien espaces verts",
      clientName: "SCI Bardin",
      cadence: "mensuel",
      amountCents: 20_000,
      startDate: "2026-01-15",
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; plan: { due: string[]; next: string | null } };
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`contrat-owner-${RUN}@example.com`, "Contrat Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Contrat ${RUN}`, slug: `org-contrat-${RUN}` },
  });
  orgA = org.json().id as string;

  memberCookie = await signup(`contrat-member-${RUN}@example.com`, "Contrat Member");
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

describe("qui peut quoi", () => {
  it("un membre LIT les contrats mais n'en écrit aucun", async () => {
    /*
     * Même gabarit que les affaires : savoir qu'un passage est dû fait partie
     * du travail de terrain, fixer le montant d'un contrat non. Fermer aussi
     * la lecture priverait l'équipe de son planning ; ouvrir l'écriture
     * laisserait n'importe qui changer un prix.
     */
    await createContrat();
    const lecture = await app.inject({
      method: "GET",
      url: "/contrats",
      headers: { cookie: memberCookie },
    });
    expect(lecture.statusCode).toBe(200);
    expect((lecture.json() as { contrats: unknown[] }).contrats.length).toBeGreaterThan(0);

    for (const [method, url] of [
      ["POST", "/contrats"],
      ["PATCH", "/contrats/00000000-0000-4000-8000-000000000000"],
      ["POST", "/contrats/00000000-0000-4000-8000-000000000000/occurrences"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        payload: { label: "x", cadence: "mensuel" },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe("ce que le contrat REFUSE", () => {
  it("une fin antérieure au début est refusée, pas silencieusement vide", async () => {
    // Sans ce refus, le contrat serait accepté et rendrait un plan vide que
    // personne ne saurait expliquer — un refus est une RÉPONSE.
    const res = await app.inject({
      method: "POST",
      url: "/contrats",
      headers: { cookie: ownerCookie },
      payload: {
        label: "Incohérent",
        cadence: "mensuel",
        startDate: "2026-06-01",
        endDate: "2026-03-01",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("un contrat SUSPENDU ne génère rien, et le dit", async () => {
    const contrat = await createContrat({ label: "Suspendu" });
    await app.inject({
      method: "PATCH",
      url: `/contrats/${contrat.id}`,
      headers: { cookie: ownerCookie },
      payload: { status: "SUSPENDU" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    // 409 motivé, pas un 200 avec une liste vide : suspendre est une décision,
    // et une décision qui n'a aucun effet visible n'en est pas une.
    expect(res.statusCode).toBe(409);
    expect(String(res.json().error)).toContain("suspendu");

    // Et le plan rendu à l'écran ne compte plus de retard.
    const liste = await app.inject({
      method: "GET",
      url: "/contrats",
      headers: { cookie: ownerCookie },
    });
    const ligne = (liste.json() as { contrats: { id: string; plan: { due: string[] } }[] }).contrats.find(
      (c) => c.id === contrat.id,
    );
    expect(ligne?.plan.due).toEqual([]);
  });
});

describe("matérialiser des échéances", () => {
  it("crée une affaire par échéance due, au montant de LA PÉRIODE", async () => {
    /*
     * LE piège du ticket. Un contrat à 200 €/mois dont on écrirait le total
     * annuel sur la première intervention donnerait une marge flatteuse sur un
     * chantier et onze chantiers à zéro — « une marge trop belle est pire
     * qu'une absence de marge ». Chaque occurrence porte 200 €, pas 2 400 €.
     */
    const contrat = await createContrat({ label: "Entretien mensuel" });
    const attendues = contrat.plan.due.length;
    expect(attendues).toBeGreaterThan(1);

    const res = await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const created = (res.json() as { created: { id: string; startDate: string }[] }).created;
    expect(created.length).toBe(attendues);

    const affaires = await withTenant(orgA, (tx) =>
      tx.affaire.findMany({ where: { contratId: contrat.id }, orderBy: { startDate: "asc" } }),
    );
    expect(affaires.length).toBe(attendues);
    for (const affaire of affaires) {
      expect(Number(affaire.quotedAmountCents)).toBe(20_000);
      expect(affaire.contratId).toBe(contrat.id);
      // Le libellé porte la DATE : douze affaires au même nom seraient
      // indiscernables dans une liste.
      expect(affaire.label).toMatch(/\d{4}-\d{2}-\d{2}$/);
    }
    // Les dates générées sont exactement celles que le plan annonçait.
    expect(affaires.map((a) => a.startDate?.toISOString().slice(0, 10))).toEqual(
      contrat.plan.due,
    );
  });

  it("deux clics ne créent pas deux fois la même intervention", async () => {
    // Idempotence par `lastOccurrenceDate` : sans elle, chaque passage du
    // brief re-proposerait les mêmes interventions et le patron finirait avec
    // douze chantiers pour un seul entretien.
    const contrat = await createContrat({ label: "Idempotent" });
    const premier = await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    const second = await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    expect((premier.json() as { created: unknown[] }).created.length).toBeGreaterThan(0);
    expect((second.json() as { created: unknown[] }).created).toEqual([]);

    const total = await withTenant(orgA, (tx) =>
      tx.affaire.count({ where: { contratId: contrat.id } }),
    );
    expect(total).toBe((premier.json() as { created: unknown[] }).created.length);
  });

  it("un contrat dormant est TRONQUÉ, et la réponse le dit", async () => {
    // Sans borne, un contrat oublié depuis sept ans créerait 84 affaires d'un
    // clic. Avec une borne muette, le patron croirait avoir tout rattrapé.
    const contrat = await createContrat({ label: "Dormant", startDate: "2019-01-15" });
    const res = await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as { created: unknown[]; truncated: boolean; reason: string | null };
    expect(body.truncated).toBe(true);
    expect(String(body.reason)).toContain("tronqué");
    expect(body.created.length).toBe(24);

    // Le RESTE est rattrapable : le second clic reprend là où on s'est arrêté,
    // au lieu de perdre les échéances non listées.
    const suite = await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    expect((suite.json() as { created: unknown[] }).created.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("le rattachement reste NULLABLE", () => {
  it("une affaire sans contrat vit normalement, et supprimer un contrat la DÉTACHE", async () => {
    /*
     * Règle de structure n°1 : tout rattachement est nullable. Et la liste de
     * colonnes du `ON DELETE SET NULL` est ce qui empêche la catastrophe —
     * sans elle, Postgres annule AUSSI `tenant_id`, ce qui sort l'affaire de
     * son tenant. Vérifié ici de bout en bout, pas seulement en SQL.
     */
    const contrat = await createContrat({ label: "À détacher" });
    await app.inject({
      method: "POST",
      url: `/contrats/${contrat.id}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    const avant = await withTenant(orgA, (tx) =>
      tx.affaire.findFirstOrThrow({ where: { contratId: contrat.id } }),
    );

    await admin.contrat.delete({ where: { id: contrat.id } });

    const apres = await withTenant(orgA, (tx) =>
      tx.affaire.findUnique({ where: { id: avant.id } }),
    );
    // L'affaire SURVIT, détachée — et surtout elle est toujours dans son tenant.
    expect(apres).not.toBeNull();
    expect(apres?.contratId).toBeNull();
    expect(apres?.tenantId).toBe(orgA);
  });
});

describe("les corrections que la revue a demandées", () => {
  it("deux clics SIMULTANÉS ne créent pas deux fois les mêmes affaires", async () => {
    /*
     * LE cas que le test séquentiel ne pouvait pas voir.
     *
     * `withTenant` n'impose aucun niveau d'isolation : on est en READ
     * COMMITTED. Sans `SELECT … FOR UPDATE` sur la ligne du contrat, deux POST
     * parallèles — un double-clic suffit — lisent tous deux
     * `lastOccurrenceDate = null` et matérialisent DEUX FOIS les mêmes
     * interventions.
     */
    const contrat = await createContrat({ label: "Course" });
    const attendues = contrat.plan.due.length;
    expect(attendues).toBeGreaterThan(1);

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/contrats/${contrat.id}/occurrences`,
        headers: { cookie: ownerCookie },
      }),
      app.inject({
        method: "POST",
        url: `/contrats/${contrat.id}/occurrences`,
        headers: { cookie: ownerCookie },
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    // Le total en base est ce qui compte : la somme des deux réponses aussi.
    const total = await withTenant(orgA, (tx) =>
      tx.affaire.count({ where: { contratId: contrat.id } }),
    );
    expect(total).toBe(attendues);
    const crees =
      (a.json() as { created: unknown[] }).created.length +
      (b.json() as { created: unknown[] }).created.length;
    expect(crees).toBe(attendues);
  }, 30_000);

  it("une date qui n'existe pas au calendrier est REFUSÉE, pas décalée", async () => {
    /*
     * `new Date("2026-02-30")` ne lève pas : JS reporte au 2 mars,
     * silencieusement. Un contrat « tous les 30 février » aurait été accepté
     * puis aurait planifié ses passages en mars, sans que personne comprenne.
     */
    const res = await app.inject({
      method: "POST",
      url: "/contrats",
      headers: { cookie: ownerCookie },
      payload: { label: "30 février", cadence: "mensuel", startDate: "2026-02-30" },
    });
    expect(res.statusCode).toBe(400);

    // Et une date franchement illisible ne remonte pas en 500 Prisma.
    const pire = await app.inject({
      method: "POST",
      url: "/contrats",
      headers: { cookie: ownerCookie },
      payload: { label: "n'importe quoi", cadence: "mensuel", startDate: "2026-13-45" },
    });
    expect(pire.statusCode).toBe(400);
  });

  it("un contrat suspendu ne garde pas un motif de troncature orphelin", async () => {
    // Neutraliser le plan sans neutraliser son motif ferait dire à l'écran
    // « tronqué à 24 échéances » sous une liste vide.
    const contrat = await createContrat({ label: "Dormant suspendu", startDate: "2019-01-15" });
    await app.inject({
      method: "PATCH",
      url: `/contrats/${contrat.id}`,
      headers: { cookie: ownerCookie },
      payload: { status: "SUSPENDU" },
    });
    const liste = await app.inject({
      method: "GET",
      url: "/contrats",
      headers: { cookie: ownerCookie },
    });
    const ligne = (
      liste.json() as { contrats: { id: string; plan: { due: string[]; truncated: boolean; reason: string | null } }[] }
    ).contrats.find((c) => c.id === contrat.id);
    expect(ligne?.plan.due).toEqual([]);
    expect(ligne?.plan.truncated).toBe(false);
    expect(ligne?.plan.reason).toBeNull();
  });
});
