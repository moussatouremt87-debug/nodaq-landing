import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { SovereigntyViolationError, embed, route, routeChat } from "../src/index.js";

/**
 * Routing tests — real Postgres (RLS) + FAKE OpenAI-compatible server standing
 * in for LiteLLM. No real model call is ever made.
 */

interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  model: string;
  messages?: { role: string; content: unknown }[];
}

const recorded: RecordedRequest[] = [];
let llmShouldFail = false;

const fakeLiteLLM = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw) as RecordedRequest & { input?: string[] };
    recorded.push({
      path: req.url ?? "",
      authorization: req.headers.authorization,
      model: body.model,
      ...(body.messages ? { messages: body.messages } : {}),
    });
    if (llmShouldFail) {
      res.writeHead(500).end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/embeddings") {
      res.end(
        JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: [0.1, 0.2, 0.3] })) }),
      );
      return;
    }
    // The fake "sovereign-fast" classifier always answers `interne`.
    res.end(JSON.stringify({ choices: [{ message: { content: "interne" } }] }));
  });
});

let admin: PrismaClient;
let tenantOff: string; // frontier disabled (default)
let tenantOn: string; // frontier explicitly enabled

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeLiteLLM.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(fakeLiteLLM.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = "sk-test-master";

  admin = createAdminClient();
  await admin.classification.deleteMany();
  await admin.tenantPolicy.deleteMany();
  await admin.note.deleteMany();
  await admin.tenant.deleteMany({ where: { name: { in: ["LLM Off", "LLM On"] } } });
  tenantOff = (await admin.tenant.create({ data: { name: "LLM Off" } })).id;
  tenantOn = (await admin.tenant.create({ data: { name: "LLM On" } })).id;
  await withTenant(tenantOn, (tx) =>
    tx.tenantPolicy.create({ data: { tenantId: tenantOn, frontierEnabled: true } }),
  );
});

afterAll(async () => {
  fakeLiteLLM.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

beforeEach(() => {
  recorded.length = 0;
  llmShouldFail = false;
});

describe("route — happy path", () => {
  it("routes interne content to sovereign-fast via LiteLLM and audits a hash", async () => {
    const text = "Prépare le compte-rendu de la réunion produit";
    const result = await route({ text, tenantId: tenantOff, requestId: "req-happy" });

    expect(result).toMatchObject({ category: "interne", group: "sovereign-fast" });
    expect(result.text).toBe("interne"); // fake server's canned answer

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      path: "/v1/chat/completions",
      authorization: "Bearer sk-test-master",
      model: "sovereign-fast",
    });

    const audits = await withTenant(tenantOff, (tx) =>
      tx.classification.findMany({ where: { requestId: "req-happy" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      category: "interne",
      tier: "sovereign-fast",
      decidedBy: "rules",
      contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    });
    // The audit row must not contain the content anywhere.
    expect(JSON.stringify(audits[0])).not.toContain("réunion produit");
  });
});

describe("route — HARD GUARD (the test that matters)", () => {
  it("confidentiel forced to frontier => SovereigntyViolationError, ZERO network calls, audit 'blocked'", async () => {
    await expect(
      route(
        {
          text: "IBAN FR7630006000011234567890189",
          category: "confidentiel",
          tenantId: tenantOn, // even with frontier enabled!
          requestId: "req-violation",
        },
        { forceGroup: "frontier" },
      ),
    ).rejects.toThrow(SovereigntyViolationError);
    expect(recorded).toHaveLength(0);

    // Blocked attempts leave an audit trace too (never the content).
    const audits = await withTenant(tenantOn, (tx) =>
      tx.classification.findMany({ where: { requestId: "req-violation" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: "blocked", tier: "frontier" });
  });

  it("ANTI-DOWNGRADE: declaring non_sensible on an IBAN payload cannot open frontier", async () => {
    const r = await route(
      {
        text: "Voici l'iban fr7630006000011234567890189 du client",
        category: "non_sensible", // lying (or buggy) caller
        tenantId: tenantOn, // frontier enabled
        requestId: "req-downgrade",
      },
      { preferFrontier: true },
    );
    // classify() always runs: detected `confidentiel` overrides the declaration.
    expect(r.category).toBe("confidentiel");
    expect(r.group).toBe("sovereign-fast");
    expect(recorded.every((req) => req.model !== "frontier")).toBe(true);
  });

  it("interne forced to frontier is also blocked (sovereign-only category)", async () => {
    await expect(
      route(
        { text: "contenu métier", category: "interne", tenantId: tenantOn, requestId: "req-v2" },
        { forceGroup: "frontier" },
      ),
    ).rejects.toThrow(SovereigntyViolationError);
    expect(recorded).toHaveLength(0);
  });
});

describe("route — tenant frontier opt-in", () => {
  // Genuinely public content: the always-on classifier agrees with the caller.
  const task = { text: "Rédige un article de blog sur la facturation électronique" };

  it("non_sensible + tenant WITHOUT opt-in => stays sovereign even with preferFrontier", async () => {
    const r = await route(
      { ...task, tenantId: tenantOff, requestId: "req-off" },
      { preferFrontier: true },
    );
    expect(r.group).toBe("sovereign-fast");
    expect(recorded[0]?.model).toBe("sovereign-fast");
  });

  it("non_sensible + tenant WITH opt-in => frontier allowed", async () => {
    const r = await route(
      { ...task, tenantId: tenantOn, requestId: "req-on" },
      { preferFrontier: true },
    );
    expect(r.group).toBe("frontier");
    expect(recorded[0]?.model).toBe("frontier");
  });

  it("forcing frontier for non_sensible WITHOUT opt-in is blocked by the policy guard", async () => {
    await expect(
      route({ ...task, tenantId: tenantOff, requestId: "req-force-off" }, { forceGroup: "frontier" }),
    ).rejects.toThrow(SovereigntyViolationError);
    expect(recorded).toHaveLength(0);
  });

  it("audit rows are tenant-isolated (RLS)", async () => {
    const auditsOff = await withTenant(tenantOff, (tx) => tx.classification.findMany());
    expect(auditsOff.every((a) => a.tenantId === tenantOff)).toBe(true);
    const auditsOn = await withTenant(tenantOn, (tx) => tx.classification.findMany());
    expect(auditsOn.every((a) => a.tenantId === tenantOn)).toBe(true);
  });
});

describe("route — sovereign LLM fallback wiring", () => {
  it("ambiguous content asks the sovereign classifier then routes with its verdict", async () => {
    const r = await route({
      text: "Contenu difficile à trancher",
      tenantId: tenantOff,
      requestId: "req-ambiguous",
      hints: { ambiguous: true },
    });
    expect(r).toMatchObject({ category: "interne", decidedBy: "llm" });
    // Two calls: classification fallback + the routed completion, both sovereign.
    expect(recorded).toHaveLength(2);
    expect(recorded.every((req) => req.model === "sovereign-fast")).toBe(true);
    expect(recorded[0]?.messages?.[0]?.role).toBe("system");
  });

  it("FAIL-SAFE end to end: classifier fallback erroring => confidentiel routing", async () => {
    llmShouldFail = true; // classification call fails...
    await expect(
      route({
        text: "Contenu difficile à trancher",
        tenantId: tenantOff,
        requestId: "req-failsafe",
        hints: { ambiguous: true },
      }),
    ).rejects.toThrow(/HTTP 500/); // ...the routed call then also fails (server down)
    // But the category decided before the call was the most restrictive one:
    // the completion attempt targeted a SOVEREIGN group, never frontier.
    const models = recorded.map((r) => r.model);
    expect(models).not.toContain("frontier");

    // And the failed attempt is audited (hash only) with the fail-safe category.
    const audits = await withTenant(tenantOff, (tx) =>
      tx.classification.findMany({ where: { requestId: "req-failsafe" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: "failed", category: "confidentiel" });
  });

  it("production without LiteLLM config fails fast (no silent dev defaults)", async () => {
    const oldEnv = process.env.NODE_ENV;
    const oldUrl = process.env.LITELLM_BASE_URL;
    process.env.NODE_ENV = "production";
    delete process.env.LITELLM_BASE_URL;
    try {
      await expect(
        route({ text: "peu importe", tenantId: tenantOff, requestId: "req-prod" }),
      ).rejects.toThrow(/must be provided in production/);
    } finally {
      process.env.NODE_ENV = oldEnv;
      process.env.LITELLM_BASE_URL = oldUrl;
    }
  });
});

describe("route — images (documents photographiés, ticket 2.16)", () => {
  const JPEG_B64 = Buffer.from("fake-jpeg-bytes").toString("base64");

  it("une image durcit la catégorie à confidentiel : jamais frontier, même opt-in + preferFrontier", async () => {
    const r = await route(
      {
        text: "Extrais les champs de ce document",
        tenantId: tenantOn, // frontier activé pour ce tenant !
        requestId: "req-image-hardening",
        images: [{ mimeType: "image/jpeg", base64: JPEG_B64 }],
      },
      { preferFrontier: true },
    );
    expect(r.category).toBe("confidentiel");
    expect(r.group).toBe("sovereign-fast");
    expect(recorded.every((req) => req.model !== "frontier")).toBe(true);
  });

  it("l'image part en content-parts OpenAI (data URI) vers le tier souverain", async () => {
    await route({
      text: "Extrais les champs de ce document",
      tenantId: tenantOff,
      requestId: "req-image-parts",
      images: [{ mimeType: "image/jpeg", base64: JPEG_B64 }],
    });
    const call = recorded.find((req) => req.path === "/v1/chat/completions");
    expect(call?.model).toBe("sovereign-fast");
    const content = call?.messages?.[0]?.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
    }[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text", text: "Extrais les champs de ce document" });
    expect(content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
    });
  });

  it("l'audit hashe texte ET image (jamais le contenu), l'empreinte diffère du texte seul", async () => {
    const audits = await withTenant(tenantOff, (tx) =>
      tx.classification.findMany({ where: { requestId: "req-image-parts" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("allowed");
    const textOnlyHash = createHash("sha256")
      .update("Extrais les champs de ce document", "utf8")
      .digest("hex");
    expect(audits[0]?.contentHash).not.toBe(textOnlyHash);
    expect(JSON.stringify(audits[0])).not.toContain(JPEG_B64);
  });

  it("routeChat : une conversation multimodale est durcie à confidentiel (jamais frontier)", async () => {
    // Symétrique du durcissement de route() : le type ChatMessage accepte des
    // content-parts, donc routeChat doit appliquer LE MÊME invariant.
    const { category, group } = await routeChat(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Que contient ce document ?" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } },
            ],
          },
        ],
        tenantId: tenantOn, // frontier activé pour ce tenant !
        requestId: "req-chat-image",
      },
      { preferFrontier: true },
    );
    expect(category).toBe("confidentiel");
    expect(group).toBe("sovereign-fast");
    expect(recorded.every((req) => req.model !== "frontier")).toBe(true);

    // Le hash d'audit couvre les parts (dont l'image) — pas « conversation vide ».
    const audits = await withTenant(tenantOn, (tx) =>
      tx.classification.findMany({ where: { requestId: "req-chat-image" } }),
    );
    expect(audits).toHaveLength(1);
    const emptyHash = createHash("sha256").update("(conversation vide)", "utf8").digest("hex");
    expect(audits[0]?.contentHash).not.toBe(emptyHash);
  });

  it("le plafond agrégé d'images est appliqué (rejet Zod, zéro réseau)", async () => {
    const big = "a".repeat(8_000_000);
    await expect(
      route({
        text: "doc",
        tenantId: tenantOff,
        requestId: "req-image-aggregate",
        images: [
          { mimeType: "image/jpeg", base64: big },
          { mimeType: "image/jpeg", base64: big },
        ],
      }),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it("type MIME hors liste (jamais de SVG/GIF) => rejet Zod, zéro appel réseau", async () => {
    await expect(
      route({
        text: "doc",
        tenantId: tenantOff,
        requestId: "req-image-mime",
        images: [{ mimeType: "image/gif" as never, base64: JPEG_B64 }],
      }),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });
});

describe("embed — always sovereign", () => {
  it("hits /v1/embeddings with the embeddings group", async () => {
    const vectors = await embed(["texte un", "texte deux"]);
    expect(vectors).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ path: "/v1/embeddings", model: "embeddings" });
  });

  it("rejects empty input (Zod)", async () => {
    await expect(embed([])).rejects.toThrow();
  });
});
