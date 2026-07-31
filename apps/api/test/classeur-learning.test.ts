import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Boucle d'apprentissage du classeur (2.16b) de bout en bout. Le modèle est
 * BOUCHONNÉ (faux LiteLLM) : ce qui est testé, c'est la mémoire dérivée des
 * corrections humaines — et surtout son cloisonnement par tenant.
 */

/** Ce que le « modèle » lit — mutable pour simuler ses trous et ses erreurs. */
let modelReads: Record<string, unknown> = {
  docType: "autre",
  supplierName: "Sogedis",
  pieceNumber: null,
  docDate: "2026-06-10",
  currency: null,
  totalExclTax: 100,
  totalTax: 20,
  totalInclTax: 120,
};

const fakeLiteLLM = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw) as { messages?: { content: unknown }[] };
    const vision = Array.isArray(body.messages?.[0]?.content);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: vision ? JSON.stringify(modelReads) : "interne" } }],
      }),
    );
  });
});

function fakeJpeg(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed, "utf8")]);
}

let app: FastifyInstance;
let admin: PrismaClient;
let cookieA: string;
let cookieB: string;
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

interface Doc {
  id: string;
  extraction: Record<string, unknown> | null;
  originalExtraction: Record<string, unknown> | null;
  learned: { field: string; value: string; evidence: number; kind: string }[] | null;
}

async function upload(seed: string, cookie: string): Promise<Doc> {
  const res = await app.inject({
    method: "POST",
    url: "/classeur/documents",
    headers: {
      cookie,
      "content-type": "application/octet-stream",
      "x-doc-filename": encodeURIComponent(`${seed}.jpg`),
    },
    payload: fakeJpeg(seed),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { document: Doc }).document;
}

/** Corrige un document — c'est CE geste qui produit la vérité terrain. */
async function correct(
  id: string,
  fields: Record<string, unknown>,
  cookie: string,
): Promise<void> {
  const res = await app.inject({
    method: "PATCH",
    url: `/classeur/documents/${id}`,
    headers: { cookie },
    payload: fields,
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeLiteLLM.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLLM.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test-master";

  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  cookieA = await signup(`learn-a-${RUN}@example.com`, "Learn A");
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: cookieA },
    payload: { name: `Org Learn A ${RUN}`, slug: `org-learn-a-${RUN}` },
  });

  cookieB = await signup(`learn-b-${RUN}@example.com`, "Learn B");
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: cookieB },
    payload: { name: `Org Learn B ${RUN}`, slug: `org-learn-b-${RUN}` },
  });
}, 60_000);

afterAll(async () => {
  fakeLiteLLM.close();
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("boucle d'apprentissage", () => {
  it("mémoire vide au départ : rien n'est appliqué", async () => {
    const first = await upload(`a1-${RUN}`, cookieA);
    expect(first.learned).toBeNull();
    expect(first.extraction?.currency).toBeNull();

    const memory = await app.inject({
      method: "GET",
      url: "/classeur/memoire",
      headers: { cookie: cookieA },
    });
    expect(memory.statusCode).toBe(200);
    expect((memory.json() as { suppliers: unknown[] }).suppliers).toHaveLength(0);
    expect(memory.headers["cache-control"]).toBe("private, no-store");
  });

  it("UNE correction ne suffit pas : le classement suivant reste vierge", async () => {
    const doc = await upload(`a2-${RUN}`, cookieA);
    await correct(doc.id, { currency: "EUR", docType: "facture_fournisseur" }, cookieA);

    const next = await upload(`a3-${RUN}`, cookieA);
    expect(next.learned).toBeNull();
    expect(next.extraction?.currency).toBeNull();
  });

  it("deux corrections concordantes : le trou est comblé, et c'est EXPLIQUÉ", async () => {
    const doc = await upload(`a4-${RUN}`, cookieA);
    await correct(doc.id, { currency: "EUR", docType: "facture_fournisseur" }, cookieA);

    const learned = await upload(`a5-${RUN}`, cookieA);
    expect(learned.extraction?.currency).toBe("EUR");
    expect(learned.extraction?.docType).toBe("facture_fournisseur");
    const currency = learned.learned?.find((entry) => entry.field === "currency");
    expect(currency?.kind).toBe("comble");
    expect(currency?.evidence).toBeGreaterThanOrEqual(2);

    // La lecture BRUTE du modèle est conservée : sans elle, la mémoire
    // s'auto-alimenterait de ses propres suggestions.
    expect(learned.originalExtraction?.currency).toBeNull();
  });

  it("la mémoire est CONSULTABLE : « il apprend votre entreprise » se vérifie", async () => {
    const memory = await app.inject({
      method: "GET",
      url: "/classeur/memoire",
      headers: { cookie: cookieA },
    });
    const body = memory.json() as {
      suppliers: { displayName: string; fields: { field: string; evidence: number }[] }[];
      minEvidence: number;
    };
    const sogedis = body.suppliers.find((s) => s.displayName === "Sogedis");
    expect(sogedis?.fields.some((f) => f.field === "currency")).toBe(true);
    expect(body.minEvidence).toBe(2);
  });

  it("le modèle a lu autre chose : DÉSACCORD signalé, valeur lue conservée", async () => {
    const previous = modelReads;
    modelReads = { ...previous, currency: "USD" };
    try {
      const doc = await upload(`a6-${RUN}`, cookieA);
      // Ce que le modèle a lu reste — l'humain tranchera.
      expect(doc.extraction?.currency).toBe("USD");
      const flag = doc.learned?.find((entry) => entry.field === "currency");
      expect(flag?.kind).toBe("desaccord");
      expect(flag?.value).toBe("EUR");
    } finally {
      modelReads = previous;
    }
  });

  it("une fois l'humain arbitré, la suggestion cesse de s'afficher", async () => {
    const previous = modelReads;
    modelReads = { ...previous, currency: "USD" };
    let doc: Doc;
    try {
      doc = await upload(`a8-${RUN}`, cookieA);
    } finally {
      modelReads = previous;
    }
    expect(doc.learned?.some((entry) => entry.field === "currency")).toBe(true);

    // L'owner tranche : « à trancher » ne doit pas rester au présent pour
    // toujours. Les traces sur les AUTRES champs, elles, survivent.
    await correct(doc.id, { currency: "EUR" }, cookieA);
    const after = await app.inject({
      method: "GET",
      url: "/classeur/documents",
      headers: { cookie: cookieA },
    });
    const refreshed = (after.json() as { documents: Doc[] }).documents.find(
      (entry) => entry.id === doc.id,
    );
    expect(refreshed?.learned?.some((entry) => entry.field === "currency")).toBeFalsy();
    // Les listes de documents ne sont pas mises en cache non plus.
    expect(after.headers["cache-control"]).toBe("private, no-store");
  });

  it("CLOISONNEMENT : les corrections d'un tenant n'apprennent RIEN à l'autre", async () => {
    // Le tenant A a appris « Sogedis paie en EUR ». Le tenant B, qui n'a rien
    // corrigé, doit repartir de zéro sur le MÊME fournisseur.
    const foreign = await upload(`b1-${RUN}`, cookieB);
    expect(foreign.learned).toBeNull();
    expect(foreign.extraction?.currency).toBeNull();

    const memory = await app.inject({
      method: "GET",
      url: "/classeur/memoire",
      headers: { cookie: cookieB },
    });
    expect((memory.json() as { suppliers: unknown[] }).suppliers).toHaveLength(0);
  });

  it("une contradiction humaine gèle le champ au lieu de trancher", async () => {
    const doc = await upload(`a7-${RUN}`, cookieA);
    // L'owner change d'avis sur ce fournisseur : devise contradictoire.
    await correct(doc.id, { currency: "CHF" }, cookieA);

    const memory = await app.inject({
      method: "GET",
      url: "/classeur/memoire",
      headers: { cookie: cookieA },
    });
    const body = memory.json() as {
      suppliers: { displayName: string; conflicts: string[]; fields: { field: string }[] }[];
    };
    const sogedis = body.suppliers.find((s) => s.displayName === "Sogedis");
    expect(sogedis?.conflicts).toContain("currency");
    expect(sogedis?.fields.some((f) => f.field === "currency")).toBe(false);
  });
});
