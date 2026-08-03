import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * SPIKE F1 — la porte souveraine de la transcription.
 *
 * Ce que ces tests verrouillent n'est pas « ça marche » (personne ne peut le
 * savoir sans vrai micro et vraie clé), mais « ça ne peut pas fuiter » : une
 * dictée est confidentielle par construction, elle ne peut donc pas partir vers
 * un modèle non souverain, et son CONTENU ne doit jamais atterrir en base ni
 * dans un log.
 */

const created: Record<string, unknown>[] = [];

vi.mock("@nodaq/db", () => ({
  withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      classification: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        },
      },
    }),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  created.length = 0;
  process.env.LITELLM_BASE_URL = "http://litellm.test";
  process.env.LITELLM_MASTER_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubTranscription(text: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(String(url)).toContain("/v1/audio/transcriptions");
      return new Response(JSON.stringify({ text }), { status: 200 });
    }),
  );
}

describe("transcription souveraine", () => {
  it("transcrit et rend la catégorie CONFIDENTIEL, pour que l'appelant la propage", async () => {
    const { transcribe } = await import("../src/transcribe.js");
    stubTranscription("Devis pour la rénovation de la salle de bain");
    const result = await transcribe({
      audio: new Uint8Array([1, 2, 3]),
      fileName: "dictee.webm",
      tenantId: TENANT,
      requestId: "req-1",
    });
    expect(result.text).toContain("rénovation");
    // Le texte issu d'une dictée reste confidentiel : le dire permet à
    // l'appelant de ne pas le renvoyer vers un modèle frontier ensuite.
    expect(result.category).toBe("confidentiel");
    expect(result.group).toBe("sovereign-strong");
  });

  it("audite l'empreinte de l'AUDIO, jamais le texte obtenu", async () => {
    const { transcribe } = await import("../src/transcribe.js");
    stubTranscription("Madame Martin, 12 rue des Lilas, 4 200 euros");
    await transcribe({
      audio: new Uint8Array([9, 9, 9]),
      fileName: "dictee.webm",
      tenantId: TENANT,
      requestId: "req-2",
    });
    const row = created[0];
    expect(row).toBeDefined();
    // Ce qui est écrit est un condensat, et il porte sur l'AUDIO.
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Le nom du client et le montant ne doivent apparaître NULLE PART.
    expect(JSON.stringify(row)).not.toContain("Martin");
    expect(JSON.stringify(row)).not.toContain("4 200");
    expect(row?.category).toBe("confidentiel");
    expect(row?.decidedBy).toBe("rules");
  });

  it("un échec laisse une trace d'audit, pas un silence", async () => {
    const { transcribe } = await import("../src/transcribe.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await expect(
      transcribe({
        audio: new Uint8Array([1]),
        fileName: "dictee.webm",
        tenantId: TENANT,
        requestId: "req-3",
      }),
    ).rejects.toThrow();
    expect(created[0]?.outcome).toBe("failed");
  });

  it("refuse un audio au-delà de la borne, au lieu de l'envoyer", async () => {
    const { transcribe, TRANSCRIPTION_MAX_BYTES } = await import("../src/transcribe.js");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      transcribe({
        audio: new Uint8Array(TRANSCRIPTION_MAX_BYTES + 1),
        fileName: "dictee.webm",
        tenantId: TENANT,
        requestId: "req-4",
      }),
    ).rejects.toThrow(/cap/);
    // Rien n'est parti sur le réseau.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aucune API ne permet de demander un tier NON souverain", async () => {
    // Contrairement à `route()`, il n'existe ni `preferFrontier` ni
    // `forceGroup` : le seul moyen d'envoyer une dictée à un modèle frontier
    // serait de modifier ce fichier, ce qui se verrait en diff.
    const module = await import("../src/transcribe.js");
    const raw = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/transcribe.ts", import.meta.url), "utf-8"),
    );
    // Commentaires RETIRÉS avant l'examen : la première version de ce test
    // échouait sur sa propre documentation, qui cite `preferFrontier` pour
    // expliquer son absence. Une garde qui se déclenche sur de la prose ne
    // garde rien — elle apprend seulement à ne plus rien écrire.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("preferFrontier");
    expect(code).not.toContain("forceGroup");
    expect(Object.keys(module.TranscribeTask.shape)).not.toContain("group");
    expect(Object.keys(module.TranscribeTask.shape)).not.toContain("category");
  });
});
