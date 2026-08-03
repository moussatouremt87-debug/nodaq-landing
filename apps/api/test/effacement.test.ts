import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Droit à l'effacement (RGPD art. 17) — ce que les purges LAISSAIENT derrière.
 *
 * Le fil de ces tests n'est pas « la ligne est-elle partie » mais « le produit
 * tient-il ce qu'il affirme ». Trois routes se disaient effaçantes et ne
 * l'étaient qu'à moitié :
 *
 *   - la purge FEC effaçait le journal, pas les propositions qui en dérivent ;
 *   - effacer une pièce du classeur laissait une proposition portant le nom du
 *     fournisseur ;
 *   - effacer un prospect laissait son nom et son ADRESSE recopiés sur les
 *     affaires.
 *
 * Un effacement sans test est une promesse. Ces tests sont la promesse tenue.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let orgA: string;

const RUN = Date.now().toString(36);

function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      email: `eff-owner-${RUN}@example.com`,
      password: "a-strong-password-123",
      name: "Eff Owner",
    },
  });
  ownerCookie = cookiesOf(signup);
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Eff ${RUN}`, slug: `org-eff-${RUN}` },
  });
  orgA = org.json().id as string;
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

/** Proposition d'immobilisation telle que l'import FEC ou le classeur la crée. */
async function seedProposal(sourceRef: string, status = "pending"): Promise<string> {
  const created = await withTenant(orgA, (tx) =>
    tx.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "create_fixed_asset",
        status,
        employee: "compta",
        payload: {
          // Ce que la purge doit faire disparaître : un libellé de compte ou un
          // nom de fournisseur, et des montants tirés de la source.
          label: "Camionnette — SARL Dupont",
          category: "materiel_transport",
          baseCents: 1_800_000,
          sourceRef,
          source: "FEC",
          priorDepreciationCents: 300_000,
          warnings: ["durée proposée — à ajuster"],
        },
      },
    }),
  );
  return created.id;
}

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const row = await withTenant(orgA, (tx) =>
    tx.pendingAction.findUniqueOrThrow({ where: { id } }),
  );
  return row.payload as Record<string, unknown>;
}

describe("purge FEC — les dérivés partent avec la source", () => {
  it("une proposition EN ATTENTE est rejetée ET réduite", async () => {
    // Approuver une proposition dont le journal a disparu créerait une
    // immobilisation que plus personne ne peut vérifier.
    await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-purge-${RUN}`,
          entryCount: 1,
          customerCount: 0,
          invoiceCount: 0,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const proposalId = await seedProposal(`fec:2182-${RUN}`);

    const res = await app.inject({
      method: "DELETE",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(204);

    const row = await withTenant(orgA, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: proposalId } }),
    );
    expect(row.status).toBe("rejected");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.reduced).toBe(true);
    // Le test qui compte : plus AUCUN dérivé du journal.
    expect(payload.label).toBeUndefined();
    expect(payload.baseCents).toBeUndefined();
    expect(payload.priorDepreciationCents).toBeUndefined();
    expect(payload.warnings).toBeUndefined();
  });

  it("une proposition DÉJÀ DÉCIDÉE garde sa trace, mais perd ses dérivés", async () => {
    // Qui a décidé quoi, et quand, n'est pas une donnée dérivée du journal :
    // c'est la trace d'une décision humaine. L'effacement d'une source ne
    // réécrit pas l'histoire — il retire ce qui venait de la source.
    await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-purge2-${RUN}`,
          entryCount: 1,
          customerCount: 0,
          invoiceCount: 0,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const proposalId = await seedProposal(`fec:2183-${RUN}`, "executed");

    await app.inject({
      method: "DELETE",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });

    const row = await withTenant(orgA, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: proposalId } }),
    );
    expect(row.status).toBe("executed");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.reduced).toBe(true);
    expect(payload.label).toBeUndefined();
  });
});

describe("classeur — effacer la pièce efface ce qui en dérive", () => {
  it("la proposition née de la photo perd le nom du fournisseur", async () => {
    const document = await withTenant(orgA, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgA,
          fileName: "facture.jpg",
          mimeType: "image/jpeg",
          byteSize: 1024,
          photo: Buffer.from("photo"),
          sha256: `sha-${RUN}-principal`,
          status: "a_verifier",
        },
      }),
    );
    const proposalId = await seedProposal(`classeur:${document.id}`);

    const res = await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${document.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(204);

    const payload = await payloadOf(proposalId);
    expect(payload.reduced).toBe(true);
    expect(payload.label).toBeUndefined();
  });

  it("effacer une pièce ne touche PAS la proposition d'une AUTRE pièce", async () => {
    // Le préfixe `classeur:<id>` doit viser une pièce, pas toutes. Sans cette
    // garde, effacer un document réduirait la file entière.
    const [gardee, effacee] = await Promise.all([
      withTenant(orgA, (tx) =>
        tx.classeurDocument.create({
          data: {
            tenantId: orgA,
            fileName: "gardee.jpg",
            mimeType: "image/jpeg",
            byteSize: 10,
            photo: Buffer.from("a"),
            sha256: `sha-${RUN}-gardee`,
            status: "a_verifier",
          },
        }),
      ),
      withTenant(orgA, (tx) =>
        tx.classeurDocument.create({
          data: {
            tenantId: orgA,
            fileName: "effacee.jpg",
            mimeType: "image/jpeg",
            byteSize: 10,
            photo: Buffer.from("b"),
            sha256: `sha-${RUN}-effacee`,
            status: "a_verifier",
          },
        }),
      ),
    ]);
    const survivante = await seedProposal(`classeur:${gardee.id}`);
    const condamnee = await seedProposal(`classeur:${effacee.id}`);

    await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${effacee.id}`,
      headers: { cookie: ownerCookie },
    });

    expect((await payloadOf(condamnee)).reduced).toBe(true);
    expect((await payloadOf(survivante)).label).toBe("Camionnette — SARL Dupont");
  });
});

describe("prospect — l'identité recopiée sur les affaires", () => {
  async function seedProspect(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/prospects",
      headers: { cookie: ownerCookie },
      payload: { name: `Jean Dupont ${RUN}`, stage: "nouveau", source: "recommandation" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function seedAffaire(prospectId: string, status: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: ownerCookie },
      payload: {
        label: `Chantier ${status}`,
        prospectId,
        status,
        clientName: "Jean Dupont",
        address: "12 rue des Lilas, Aix-en-Provence",
        latitude: 43.53,
        longitude: 5.45,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("une affaire JAMAIS contractée est anonymisée : nom, adresse et GPS", async () => {
    // Un devis perdu ne fonde RIEN. Garder l'adresse — souvent le domicile —
    // d'une personne qui demande son effacement n'a aucune base.
    const prospectId = await seedProspect();
    const perdue = await seedAffaire(prospectId, "PERDUE");

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affairesAnonymisees).toBe(1);

    const after = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: perdue } }),
    );
    expect(after.clientName).toBeNull();
    expect(after.address).toBeNull();
    expect(after.latitude).toBeNull();
    expect(after.longitude).toBeNull();
    // L'affaire SURVIT : c'est un effacement de données personnelles, pas la
    // destruction d'un historique de chantiers.
    expect(after.label).toBe("Chantier PERDUE");
  });

  it("une affaire EN COURS garde ses données — l'exécution du contrat les fonde", async () => {
    const prospectId = await seedProspect();
    const enCours = await seedAffaire(prospectId, "EN_COURS");

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.json().affairesAnonymisees).toBe(0);
    const conservees = res.json().affairesConservees;
    expect(conservees).toHaveLength(1);
    expect(conservees[0].motif).toContain("contrat");

    const after = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: enCours } }),
    );
    expect(after.clientName).toBe("Jean Dupont");
  });

  it("une affaire ARCHIVÉE est conservée et SIGNALÉE — ce qui reste est dit", async () => {
    // L'archivage est la sortie commune des affaires gagnées ET perdues : le
    // statut ne dit plus si un contrat a existé. Trancher au hasard détruirait
    // de la donnée contractuelle une fois sur deux. On rapporte, et l'owner
    // termine à la main.
    const prospectId = await seedProspect();
    await seedAffaire(prospectId, "ARCHIVEE");
    await seedAffaire(prospectId, "PROSPECT");

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    expect(body.affairesAnonymisees).toBe(1);
    expect(body.affairesConservees).toHaveLength(1);
    expect(body.affairesConservees[0].status).toBe("ARCHIVEE");
    // Le motif rend le reste ACTIONNABLE : sans lui, l'owner ne saurait pas
    // qu'il lui reste quelque chose à décider.
    expect(body.affairesConservees[0].motif).toContain("à vérifier");
    expect(body.affairesConservees[0].reference).toMatch(/^\d{4}-\d{3}$/);
  });
});
