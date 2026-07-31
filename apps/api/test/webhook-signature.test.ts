import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateWebhookSecret,
  parseWebhookEnvelope,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookRateLimiter,
  WebhookSecretCache,
} from "../src/webhooks.js";

/*
 * Socle webhooks entrants (2.13) — vérification de signature PURE : une
 * requête webhook n'a AUCUNE session, la signature est la SEULE preuve
 * d'authenticité. Tout ce qui n'est pas prouvé est refusé (fail-closed),
 * sans jamais dire POURQUOI au client (pas d'oracle).
 */

const SECRET = "a".repeat(64);
const BODY = Buffer.from(JSON.stringify({ id: "evt-1", type: "invoice.paid" }));
const NOW = new Date("2026-08-01T12:00:00Z");

function headerFor(body: Buffer, secret: string, at: Date): string {
  return signWebhookPayload(secret, Math.floor(at.getTime() / 1000), body);
}

describe("generateWebhookSecret", () => {
  it("génère un secret imprévisible de 256 bits, jamais deux fois le même", () => {
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepte une signature valide dans la fenêtre de tolérance", () => {
    const header = headerFor(BODY, SECRET, NOW);
    expect(verifyWebhookSignature({ header, body: BODY, secret: SECRET, now: NOW })).toMatchObject({
      ok: true,
    });
  });

  it("refuse un corps modifié d'UN octet (la signature couvre tout le corps)", () => {
    const header = headerFor(BODY, SECRET, NOW);
    const tampered = Buffer.from(JSON.stringify({ id: "evt-1", type: "invoice.PAID" }));
    expect(
      verifyWebhookSignature({ header, body: tampered, secret: SECRET, now: NOW }),
    ).toMatchObject({ ok: false, reason: "signature" });
  });

  it("refuse un autre secret (même corps, même horodatage)", () => {
    const header = headerFor(BODY, SECRET, NOW);
    const other = randomBytes(32).toString("hex");
    expect(verifyWebhookSignature({ header, body: BODY, secret: other, now: NOW })).toMatchObject({
      ok: false,
      reason: "signature",
    });
  });

  it("REJEU : une signature valide mais trop vieille (ou trop future) est refusée", () => {
    const old = new Date(NOW.getTime() - (WEBHOOK_TOLERANCE_SECONDS + 60) * 1000);
    const future = new Date(NOW.getTime() + (WEBHOOK_TOLERANCE_SECONDS + 60) * 1000);
    for (const at of [old, future]) {
      const header = headerFor(BODY, SECRET, at);
      expect(verifyWebhookSignature({ header, body: BODY, secret: SECRET, now: NOW })).toMatchObject(
        { ok: false, reason: "timestamp" },
      );
    }
    // Juste dans la fenêtre : accepté.
    const edge = new Date(NOW.getTime() - (WEBHOOK_TOLERANCE_SECONDS - 5) * 1000);
    expect(
      verifyWebhookSignature({ header: headerFor(BODY, SECRET, edge), body: BODY, secret: SECRET, now: NOW }),
    ).toMatchObject({ ok: true });
  });

  it("en-tête absent, malformé ou tronqué : refus net, jamais une exception", () => {
    for (const header of [
      undefined,
      "",
      "garbage",
      "t=,v1=",
      "v1=deadbeef",
      `t=${Math.floor(NOW.getTime() / 1000)}`,
      `t=pas-un-nombre,v1=${"0".repeat(64)}`,
      // Longueur de digest incorrecte : refusé AVANT toute comparaison.
      `t=${Math.floor(NOW.getTime() / 1000)},v1=abcd`,
    ]) {
      const result = verifyWebhookSignature({
        ...(header === undefined ? {} : { header }),
        body: BODY,
        secret: SECRET,
        now: NOW,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("signature calculée sur `t.corps` : déplacer l'horodatage invalide la preuve", () => {
    const timestamp = Math.floor(NOW.getTime() / 1000);
    // HMAC du corps SEUL (sans le timestamp) : refusé — sinon un attaquant
    // pourrait rejouer un corps signé avec un horodatage frais.
    const bodyOnly = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(
      verifyWebhookSignature({
        header: `t=${timestamp},v1=${bodyOnly}`,
        body: BODY,
        secret: SECRET,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: "signature" });
  });
});

describe("WebhookRateLimiter", () => {
  it("borne le débit par clé et rouvre après la fenêtre", () => {
    const limiter = new WebhookRateLimiter(3, 1_000);
    const t0 = 1_000_000;
    expect([limiter.take("ip-a", t0), limiter.take("ip-a", t0), limiter.take("ip-a", t0)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take("ip-a", t0)).toBe(false);
    // Une autre source n'est pas pénalisée.
    expect(limiter.take("ip-b", t0)).toBe(true);
    // Fenêtre suivante : le quota est rendu.
    expect(limiter.take("ip-a", t0 + 1_200)).toBe(true);
  });

  it("plafonne le nombre de clés suivies : une inondation d'IP ne fait pas grossir la mémoire", () => {
    const limiter = new WebhookRateLimiter(5, 60_000, 10);
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) expect(limiter.take(`ip-${i}`, t0)).toBe(true);
    // Table pleine d'entrées ENCORE valides : on refuse plutôt que de croître.
    expect(limiter.take("ip-nouvelle", t0)).toBe(false);
    // Une fois la fenêtre passée, les entrées expirées sont recyclées.
    expect(limiter.take("ip-nouvelle", t0 + 60_001)).toBe(true);
  });
});

describe("WebhookSecretCache", () => {
  it("sert le secret pendant sa durée de vie, l'oublie ensuite, et s'invalide à la rotation", () => {
    const cache = new WebhookSecretCache(1_000);
    const t0 = 3_000_000;
    cache.set("webhook/t/pdp", "s1", t0);
    expect(cache.get("webhook/t/pdp", t0 + 500)).toBe("s1");
    expect(cache.get("webhook/t/pdp", t0 + 1_500)).toBeUndefined();
    cache.set("webhook/t/pdp", "s2", t0);
    cache.invalidate("webhook/t/pdp");
    expect(cache.get("webhook/t/pdp", t0)).toBeUndefined();
  });
});

describe("parseWebhookEnvelope", () => {
  it("exige un id d'événement (idempotence) et borne les champs", () => {
    expect(parseWebhookEnvelope({ id: "evt-1", type: "invoice.paid" })).toMatchObject({
      externalId: "evt-1",
      eventType: "invoice.paid",
    });
    // Variantes de nommage tolérées (les fournisseurs divergent).
    expect(parseWebhookEnvelope({ event_id: "evt-2", event_type: "x" })?.externalId).toBe("evt-2");
    // Sans identifiant : impossible d'être idempotent -> refus.
    expect(parseWebhookEnvelope({ type: "invoice.paid" })).toBeNull();
    expect(parseWebhookEnvelope("pas un objet")).toBeNull();
    expect(parseWebhookEnvelope({ id: "x".repeat(500) })).toBeNull();
  });
});
