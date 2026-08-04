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
    /*
     * Version précédente de ce test : elle cherchait la chaîne « audio » dans
     * le payload. Elle serait passée à l'identique contre un code stockant le
     * base64 de l'enregistrement sous n'importe quelle autre clé — `raw`,
     * `blob`, `source`. Le titre promettait donc plus que l'assertion.
     *
     * On liste les clés de façon EXHAUSTIVE : toute clé nouvelle fait échouer
     * le test, ce qui force à venir se demander si elle a le droit d'exister.
     */
    const res = await dicter(oggAudio(4096));
    const action = await withTenant(orgId, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: res.json().pendingActionId } }),
    );
    const payload = action.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["label", "quote", "source", "transcript"]);

    // Et aucune valeur ne ressemble à du binaire encodé : l'audio envoyé fait
    // 4 Ko, donc ~5,5 Ko en base64. Rien d'aussi long n'a le droit d'être là.
    for (const value of Object.values(payload)) {
      if (typeof value === "string") expect(value.length).toBeLessThan(2_000);
    }
  });

  it("la transcription DISPARAÎT à la décision — seule borne de rétention", async () => {
    // La transcription est le verbatim de ce que le patron a dit : nom du
    // client, adresse du chantier. Elle est conservée tant que la décision
    // n'est pas prise, parce que c'est ce qui rend la relecture possible — et
    // pas une minute de plus.
    const res = await dicter(oggAudio());
    const id = res.json().pendingActionId as string;
    const rejected = await app.inject({
      method: "POST",
      url: `/pending-actions/${id}/reject`,
      headers: { cookie: ownerCookie },
    });
    expect(rejected.statusCode).toBe(200);

    const action = await withTenant(orgId, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id } }),
    );
    const payload = action.payload as Record<string, unknown>;
    expect(payload.transcript).toBeUndefined();
    expect(payload.reduced).toBe(true);
    // La provenance survit : elle sert à relire la file, elle n'identifie
    // personne.
    expect(payload.source).toBe("dictee");
  });
});

describe("la souveraineté est PROPAGÉE, pas seulement affirmée", () => {
  it("l'extraction qui suit la transcription reste sur le tier souverain", async () => {
    /*
     * `transcribe()` fixe la catégorie à `confidentiel` et la RETOURNE pour
     * que l'appelant la propage. C'est ici que cette règle tient ou pas : si
     * l'extraction passait `interne`, le texte de la dictée — nom du client,
     * adresse du chantier — redeviendrait éligible au tier frontier.
     *
     * L'en-tête de ce fichier annonçait cette garantie sans qu'aucune
     * assertion ne la regarde. Elle en a une : l'audit de classification.
     */
    const before = await withTenant(orgId, (tx) =>
      tx.classification.count({ where: { category: "confidentiel", outcome: "allowed" } }),
    );
    await dicter(oggAudio());
    const after = await withTenant(orgId, (tx) =>
      tx.classification.count({ where: { category: "confidentiel", outcome: "allowed" } }),
    );
    // Deux appels modèle, deux décisions auditées en `confidentiel` : la
    // transcription ET l'extraction.
    expect(after - before).toBeGreaterThanOrEqual(2);

    // Et AUCUNE décision non confidentielle n'a été prise au passage.
    const relaxed = await withTenant(orgId, (tx) =>
      tx.classification.count({ where: { category: { not: "confidentiel" } } }),
    );
    expect(relaxed).toBe(0);
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

describe("l'autorisation est vérifiée AVANT de bufferiser", () => {
  it("un anonyme est refusé sans que son corps soit lu", async () => {
    /*
     * C'est ce qui rend le choix `onRequest` (et non `preHandler`)
     * load-bearing : sans lui, un anonyme coûterait 25 Mo d'allocation avant
     * d'être refusé. Aucun test ne le gardait.
     */
    const before = transcriptionCalls;
    const res = await app.inject({
      method: "POST",
      url: "/devis/dictee",
      headers: { "content-type": "application/octet-stream" },
      payload: oggAudio(),
    });
    expect(res.statusCode).toBe(401);
    expect(transcriptionCalls).toBe(before);
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
