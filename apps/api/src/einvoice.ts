import { z } from "zod";
import { withTenant } from "@nodaq/db";
import type { Prisma } from "@nodaq/db";
import { isValidTransition, normalizeStatus } from "@nodaq/facturx";
import type { SubmissionStatus } from "@nodaq/facturx";
import type { WebhookHandler } from "./webhooks.js";

/*
 * PDP status intake (ticket 2.4) — the return path of an e-invoice.
 *
 * Once deposited, an invoice lives on the network: the platform reports what
 * happened to it (received, taken over, approved, refused, cashed). Those
 * statuses arrive through the webhook socket (2.13), which already proved
 * authenticity (HMAC) and resolved the tenant FROM THE ENDPOINT. What is left
 * here is the business rule, and it is deliberately strict:
 *
 *  - an UNKNOWN status is never guessed into a known one — the event is
 *    ignored and counted, because inventing "approuvee" out of a vendor
 *    string would tell the owner an invoice is accepted when it is not;
 *  - a status is applied ONLY through `isValidTransition`. A replayed or
 *    out-of-order delivery therefore cannot rewrite history backwards
 *    ("encaissee" -> "deposee"), which is the whole reason the guard exists;
 *  - the history is append-only and BOUNDED: a chatty platform must not grow
 *    a row without limit.
 *
 * Nothing here logs the payload: a status event carries the invoice number,
 * which is business data. The socket itself keeps the delivered body for 90
 * days (2.13 retention) now that a handler gives it a purpose — that storage
 * is the socket's, and this module adds nothing to it.
 */

/** Hard cap on stored history entries — oldest are dropped, newest kept. */
export const MAX_STATUS_HISTORY = 50;

/**
 * Statuses a (re)deposit may legitimately start from: the invoice is not on
 * the platform yet (`prete`), or a transport failure left it unsent
 * (`erreur`). Any other status means the platform HAS the document, and a
 * second deposit would be visible to the customer.
 */
export const REDEPOSITABLE_STATUSES = new Set(["prete", "erreur"]);

/**
 * Status envelope. Platforms differ in naming, so both the platform
 * reference and our invoice number are accepted as the correlation key —
 * the reference wins when both are present.
 */
const StatusEvent = z
  .object({
    reference: z.string().min(1).max(200).optional(),
    submission_id: z.string().min(1).max(200).optional(),
    invoice_number: z.string().min(1).max(200).optional(),
    invoiceNumber: z.string().min(1).max(200).optional(),
    status: z.string().min(1).max(100).optional(),
    state: z.string().min(1).max(100).optional(),
  })
  .passthrough();

export interface StatusEventRef {
  reference: string | null;
  invoiceNumber: string | null;
  status: SubmissionStatus;
}

/**
 * Reads a status event. Returns null when it cannot be applied SAFELY:
 * no correlation key, or a status this product does not know. Both cases are
 * a refusal, never a default.
 */
export function parseStatusEvent(payload: unknown): StatusEventRef | null {
  const parsed = StatusEvent.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  const reference = data.reference ?? data.submission_id ?? null;
  const invoiceNumber = data.invoice_number ?? data.invoiceNumber ?? null;
  if (!reference && !invoiceNumber) return null;
  const raw = data.status ?? data.state;
  if (!raw) return null;
  const status = normalizeStatus(raw);
  if (!status) return null;
  return { reference, invoiceNumber, status };
}

/**
 * Shrinks a finished action's payload (art. 5.1.c — minimization).
 *
 * Two payload types carry personal or third-party data they only needed
 * BEFORE the human decided:
 *  - `submit_einvoice` holds a FULL customer invoice (name, address, SIRET,
 *    line labels) so the executor can rebuild the document deterministically;
 *  - `create_quote` prepared from an e-mail (2.7) holds the PROSPECT's name,
 *    address and the wording of their request — data about someone who is
 *    not even a customer yet.
 *
 * Once executed or rejected, that need is gone. Returns null when there is
 * nothing to shrink.
 */
export function reduceFinishedPayload(
  type: string,
  payload: unknown,
): Prisma.InputJsonValue | null {
  if (type === "create_quote") return reduceQuotePayload(payload);
  // Relance prospect (2.12) : le texte validé vit dans le journal du prospect
  // (où il suit la vie de la fiche et sa suppression), pas indéfiniment dans
  // la file. Rejetée, la proposition n'a plus aucune raison d'être conservée.
  if (type === "record_prospect_contact") {
    const data = payload as Record<string, unknown> | null;
    const prospect = (data?.prospect ?? null) as Record<string, unknown> | null;
    return {
      reduced: true,
      prospectId: typeof prospect?.id === "string" ? prospect.id : null,
      stage: typeof prospect?.stage === "string" ? prospect.stage : null,
    } as Prisma.InputJsonValue;
  }
  if (type !== "submit_einvoice") return null;
  const data = payload as Record<string, unknown> | null;
  const invoice = (data?.invoice ?? null) as Record<string, unknown> | null;
  return {
    reduced: true,
    // Ce qui reste = ce qui permet de RELIRE la file, pas de reconstruire la
    // facture : numéro, montant, profil.
    invoiceNumber: typeof invoice?.number === "string" ? invoice.number : null,
    grossCents: typeof data?.grossCents === "number" ? data.grossCents : null,
    currency: typeof data?.currency === "string" ? data.currency : null,
    profile: typeof data?.profile === "string" ? data.profile : null,
    label: typeof data?.label === "string" ? data.label : null,
  } as Prisma.InputJsonValue;
}

/**
 * Réduction d'une proposition de devis terminée : on garde de quoi RELIRE la
 * file (combien de lignes, d'où venait la demande), on jette ce qui identifie
 * le prospect et le contenu de sa demande. Un tiers qui a écrit une fois ne
 * doit pas rester en base indéfiniment.
 */
function reduceQuotePayload(payload: unknown): Prisma.InputJsonValue {
  const data = payload as Record<string, unknown> | null;
  const quote = (data?.quote ?? null) as Record<string, unknown> | null;
  const lines = Array.isArray(quote?.lines) ? quote.lines.length : 0;
  return {
    reduced: true,
    source: typeof data?.source === "string" ? data.source : null,
    lines,
    unmatchedCount: typeof quote?.unmatchedCount === "number" ? quote.unmatchedCount : null,
  } as Prisma.InputJsonValue;
}

export type StatusOutcome = "applied" | "ignored" | "unknown-submission";

/** Appends to the bounded history without ever dropping the newest entry. */
export function appendHistory(
  existing: Prisma.JsonValue,
  entry: { status: string; at: string; reference?: string | null },
): Prisma.InputJsonValue {
  const previous = Array.isArray(existing) ? existing : [];
  const next = [...previous, entry];
  return next.slice(-MAX_STATUS_HISTORY) as unknown as Prisma.InputJsonValue;
}

/**
 * Applies a platform status to the matching submission. Tenant-scoped
 * through `withTenant` like every business write — the tenant comes from the
 * endpoint that authenticated the delivery, never from the payload.
 */
export async function applySubmissionStatus(
  tenantId: string,
  event: StatusEventRef,
  now = new Date(),
): Promise<StatusOutcome> {
  return withTenant(tenantId, async (tx) => {
    const submission = event.reference
      ? await tx.eInvoiceSubmission.findFirst({
          where: { pdpReference: event.reference },
          select: { id: true, status: true, statusHistory: true },
        })
      : await tx.eInvoiceSubmission.findFirst({
          where: { invoiceNumber: event.invoiceNumber ?? "", direction: "emission" },
          select: { id: true, status: true, statusHistory: true },
        });
    // Un statut pour une soumission inconnue n'est PAS créé : la ligne naît
    // du dépôt validé, jamais d'un message entrant.
    if (!submission) return "unknown-submission";

    const current = submission.status as SubmissionStatus;
    // `erreur` est une panne de NOTRE côté (le dépôt a échoué), jamais un
    // verdict de plateforme : l'accepter par ce canal permettrait à un
    // message entrant de faire retomber une facture approuvée en « erreur
    // de transmission », puis de rouvrir le cycle depuis `erreur`.
    if (event.status === "erreur") return "ignored";
    if (!isValidTransition(current, event.status)) return "ignored";

    await tx.eInvoiceSubmission.update({
      where: { id: submission.id },
      data: {
        status: event.status,
        statusHistory: appendHistory(submission.statusHistory, {
          status: event.status,
          at: now.toISOString(),
          ...(event.reference ? { reference: event.reference } : {}),
        }),
      },
    });
    return "applied";
  });
}

/**
 * Webhook handler for the `pdp` provider. Runs AFTER the 202 (2.13): a slow
 * or failing status update never turns into a provider retry storm — the
 * stored event stays replayable.
 */
export function createPdpWebhookHandler(): WebhookHandler {
  return async ({ tenantId, payload }) => {
    const event = parseStatusEvent(payload);
    // Événement non exploitable : on ne devine rien, on ne touche à rien.
    if (!event) return;
    await applySubmissionStatus(tenantId, event);
  };
}
