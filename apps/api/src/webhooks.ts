import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/*
 * Inbound webhook foundation (ticket 2.13) — the prerequisite for the PDP
 * e-invoicing flow (2.4) and the hosted Bridge Connect flow.
 *
 * A webhook request carries NO session: the HMAC signature is the ONLY proof
 * of authenticity, so everything here is fail-closed and constant-time.
 *
 * Signature scheme (Stripe-style, the de-facto standard our providers
 * implement or that we require of them):
 *
 *     X-Nodaq-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *     hmac = HMAC_SHA256(secret, "<t>.<raw body bytes>")
 *
 * The timestamp is INSIDE the signed material: a captured body cannot be
 * replayed later with a fresh timestamp. It is also checked against a
 * tolerance window — belt and braces with the (provider, externalId)
 * uniqueness that makes storage idempotent.
 */

/** Providers allowed to own an endpoint — mirrored by a CHECK in the DB. */
export const WEBHOOK_PROVIDERS = ["pdp", "bridge", "pennylane", "qonto", "test"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/** Replay window around the request timestamp, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Hex digest length of HMAC-SHA256 — a wrong length is rejected up front. */
const DIGEST_HEX_LENGTH = 64;

/** Server-generated endpoint secret: 256 bits of CSPRNG, hex-encoded. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Builds the signature header for `timestamp.body` (tests, docs, senders). */
export function signWebhookPayload(secret: string, timestamp: number, body: Buffer): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export type SignatureFailure = "header" | "timestamp" | "signature";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Verifies a signature header against the RAW body. The failure reason is for
 * server-side logging only: the route answers a constant 401 whatever the
 * reason, so a caller never learns whether the secret, the body or the clock
 * was wrong.
 */
export function verifyWebhookSignature({
  header,
  body,
  secret,
  now,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
}: {
  header?: string | undefined;
  body: Buffer;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): SignatureResult {
  if (typeof header !== "string" || header.length === 0 || header.length > 500) {
    return { ok: false, reason: "header" };
  }

  let timestamp: number | null = null;
  let provided: string | null = null;
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,15}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]+$/i.test(value)) provided = value.toLowerCase();
  }
  if (timestamp === null || provided === null) return { ok: false, reason: "header" };
  // Length checked BEFORE timingSafeEqual (which throws on mismatched sizes).
  if (provided.length !== DIGEST_HEX_LENGTH) return { ok: false, reason: "header" };

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (skew > toleranceSeconds) return { ok: false, reason: "timestamp" };

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  const equal = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  return equal ? { ok: true } : { ok: false, reason: "signature" };
}

/*
 * Provider envelopes diverge in naming; only two things are contractual for
 * us: an event id (idempotence key) and a type (routing). Everything else
 * stays in the stored payload — we never guess business meaning here.
 */
const Envelope = z
  .object({
    id: z.string().min(1).max(200).optional(),
    event_id: z.string().min(1).max(200).optional(),
    eventId: z.string().min(1).max(200).optional(),
    type: z.string().max(200).optional(),
    event_type: z.string().max(200).optional(),
    eventType: z.string().max(200).optional(),
  })
  .passthrough();

export interface WebhookEnvelope {
  externalId: string;
  eventType: string;
}

/**
 * Extracts the idempotence key and event type. Returns null when no usable
 * id is present: without it we cannot promise "replaying never duplicates",
 * so the event is refused rather than stored under a fabricated key.
 */
export function parseWebhookEnvelope(payload: unknown): WebhookEnvelope | null {
  const parsed = Envelope.safeParse(payload);
  if (!parsed.success) return null;
  const { id, event_id: eventIdSnake, eventId, type, event_type: typeSnake, eventType } = parsed.data;
  const externalId = id ?? eventIdSnake ?? eventId;
  if (!externalId) return null;
  return { externalId, eventType: type ?? typeSnake ?? eventType ?? "" };
}

/**
 * Business handlers registered per provider (PDP 2.4, Bridge…). They run
 * AFTER the event is stored and the 202 is sent: a slow or failing handler
 * never turns into a provider-side retry storm, and the stored event stays
 * the source of truth for replay.
 */
export type WebhookHandler = (event: {
  tenantId: string;
  provider: string;
  eventType: string;
  externalId: string;
  payload: unknown;
}) => Promise<void>;

export type WebhookHandlerRegistry = Partial<Record<string, WebhookHandler>>;
