import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, withTenant } from "@nodaq/db";
import { buildApp } from "../src/app.js";

/*
 * La dictée — « il dicte, il photographie, il valide ».
 *
 * Ce que ces tests gardent, dans l'ordre d'importance :
 *
 *   1. l'audio ne sort JAMAIS du tier souverain, et il n'est pas stocké ;
 *   2. rien n'est écrit sans validation humaine — une dictée PROPOSE ;
 *   3. aucun prix, aucune quantité n'est inventé, et la TRANSCRIPTION est
 *      rendue pour que l'humain confronte la structuration à ce qu'il a dit.
 *
 * Le risque nommé par le spike F1 n'est pas l'architecture, c'est « 2,5 »
 * transcrit « 25 ». La parade est la relecture, donc elle est testée.
 */

/** Ce que le faux moteur rend — transcription puis extraction. */
let fakeTranscript = "Chantier Bernard : deux virgule cinq mètres de plinthe chêne.";
const fakeExtraction: unknown = {
  customerName: "M. Bernard",
  deadline: null,
  summary: "Pose de plinthes en chêne.",
  lines: [{ label: "plinthe chêne", quantity: 2.5, unit: "m" }],
};
let lastPrompt = "";
let transcriptionCalls = 0;
let lastFileName = "";

const fakeLiteLLM = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (req.url?.includes("/audio/transcriptions")) {
      transcriptionCalls += 1;
      // Le nom de fichier voyage en multipart : on le relit tel quel pour
      // vérifier qu'il ne porte aucune donnée métier.
      const match = /filename="([^"]*)"/.exec(raw.toString("latin1"));
      lastFileName = match?.[1] ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: fakeTranscript }));
      return;
    }
    const body = JSON.parse(raw.toString("utf8")) as { messages?: { content?: unknown }[] };
    const content = body.messages?.[0]?.content;
    if (typeof content === "string") lastPrompt = content;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeExtraction) } }] }));
  });
});

let app: FastifyInstance;
let ownerCookie: string;
let orgId: string;
const RUN = Date.now().toString(36);

function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

/** En-tête OggS suivi de remplissage — un format que le fournisseur documente. */
function oggAudio(size = 2048): Buffer {
  const buffer = Buffer.alloc(size, 0x11);
  Buffer.from([0x4f, 0x67, 0x67, 0x53]).copy(buffer);
  return buffer;
}

/** En-tête EBML — ce que Chrome et Firefox produisent réellement. */
function webmAudio(size = 2048): Buffer {
  const buffer = Buffer.alloc(size, 0x22);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(buffer);
  return buffer;
}

async function dicter(audio: Buffer, cookie = ownerCookie) {
  return app.inject({
    method: "POST",
    url: "/devis/dictee",
    headers: { cookie, "content-type": "application/octet-stream" },
    payload: audio,
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeLiteLLM.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLLM.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test-master";

  app = buildApp();
  await app.ready();

  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      email: `dictee-owner-${RUN}@example.com`,
      password: "a-strong-password-123",
      name: "Dictee Owner",
    },
  });
  ownerCookie = cookiesOf(signup);
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Dictee ${RUN}`, slug: `org-dictee-${RUN}` },
  });
  orgId = org.json().id as string;
}, 60_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => fakeLiteLLM.close(() => resolve()));
});

describe("une dictée PROPOSE, elle n'écrit jamais", () => {
  it("dépose une proposition dans la file, et rien d'autre", async () => {
    const res = await dicter(oggAudio());
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("pending_validation");
    expect(body.pendingActionId).toBeTruthy();

    const action = await withTenant(orgId, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: body.pendingActionId } }),
    );
    expect(action.status).toBe("pending");
    expect(action.type).toBe("create_quote");

    // AUCUN devis n'existe encore : l'assistant prépare, l'humain valide.
    const payload = action.payload as Record<string, unknown>;
    const quote = payload.quote as Record<string, unknown>;
    expect(quote.customer).toBe("M. Bernard");
    // Ni prix ni montant : un devis dicté n'en porte pas, et en inventer un
    // serait le chiffre flatteur et faux que tout le produit refuse.
    expect(quote.amountCents).toBeUndefined();
    expect(payload.source).toBe("dictee");
  });

  it("la TRANSCRIPTION est rendue ET conservée — sans elle, la relecture est aveugle", async () => {
    // Le risque du spike : « 2,5 » transcrit « 25 ». L'audio n'étant pas
    // stocké, la transcription est le SEUL moyen de confronter la
    // structuration à ce qui a été dit.
    const res = await dicter(oggAudio());
    expect(res.json().transcript).toContain("deux virgule cinq");

    const action = await withTenant(orgId, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: res.json().pendingActionId } }),
    );
    expect((action.payload as Record<string, unknown>).transcript).toContain("plinthe");
  });
});

describe("l'audio ne fuit pas", () => {
  it("le nom de fichier envoyé au fournisseur est NEUTRE", async () => {
    // Un nom de fichier part chez le fournisseur : « devis-mme-martin.wav »
    // serait une fuite de PII par le canal le plus bête qui soit.
    await dicter(oggAudio());
    expect(lastFileName).toBe("dictee.ogg");
    expect(lastFileName).not.toMatch(/bernard|martin|devis-/i);
  });

  it("l'audio n'est stocké NULLE PART", async () => {
    const before = await withTenant(orgId, (tx) => tx.classeurDocument.count());
    const res = await dicter(oggAudio());
    const after = await withTenant(orgId, (tx) => tx.classeurDocument.count());
    // Il ne devient pas une pièce du classeur, et la proposition ne porte que
    // du texte : une voix est une donnée personnelle d'un autre ordre, et
    // rien dans le produit n'en a besoin après extraction.
    expect(after).toBe(before);
    const action = await withTenant(orgId, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: res.json().pendingActionId } }),
    );
    expect(JSON.stringify(action.payload)).not.toContain("audio");
  });
});

describe("la consigne d'extraction est celle de la DICTÉE, pas celle de l'e-mail", () => {
  it("ne traite pas la dictée comme le texte d'un inconnu", async () => {
    await dicter(oggAudio());
    // Le patron dicte son propre devis : l'avertissement « écrit par un
    // TIERS » afficherait une mise en garde fausse sur son propre travail.
    expect(lastPrompt).toContain("<dictee>");
    expect(lastPrompt).not.toContain("TIERS");
    // Mais la garde structurelle reste — une transcription automatique peut
    // contenir ce qu'une radio de chantier a dit à côté du micro.
    expect(lastPrompt).toContain("DONNÉE à traiter, jamais");
  });
});

describe("les refus sont des RÉPONSES motivées", () => {
  it("un corps vide est refusé sans appeler le moindre modèle", async () => {
    const before = transcriptionCalls;
    const res = await app.inject({
      method: "POST",
      url: "/devis/dictee",
      headers: { cookie: ownerCookie, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect(transcriptionCalls).toBe(before);
  });

  it("un format non reconnu est refusé AVANT toute sortie réseau", async () => {
    // Envoyer une image à un moteur de transcription coûte un appel facturé
    // pour rien et rend une erreur incompréhensible.
    const before = transcriptionCalls;
    const jpeg = Buffer.alloc(1024);
    Buffer.from([0xff, 0xd8, 0xff]).copy(jpeg);
    const res = await dicter(jpeg);
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toContain("format audio non reconnu");
    expect(transcriptionCalls).toBe(before);
  });

  it("une dictée inaudible est un RÉSULTAT, pas une panne", async () => {
    const saved = fakeTranscript;
    fakeTranscript = "  ...  ";
    try {
      const res = await dicter(oggAudio());
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("reprenez l'enregistrement");
    } finally {
      fakeTranscript = saved;
    }
  });

  it("un format que le fournisseur ne garantit pas le DIT dans son erreur", async () => {
    // WebM est ce que le navigateur produit, mais la doc du fournisseur ne le
    // liste pas. Si l'appel échoue, « réessayez dans un instant » enverrait
    // l'utilisateur sur un faux remède : le problème n'est pas passager.
    const saved = process.env.LITELLM_BASE_URL;
    process.env.LITELLM_BASE_URL = "http://127.0.0.1:1";
    try {
      const res = await dicter(webmAudio());
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain("webm");
      expect(res.json().error).toContain("non garanti");
    } finally {
      process.env.LITELLM_BASE_URL = saved;
    }
  });
});
