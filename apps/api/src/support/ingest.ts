import { randomUUID } from "node:crypto";
import { prisma, withOps } from "@nodaq/db";
import type { Prisma } from "@nodaq/db";
import { recordPushEvent } from "../push.js";
import { findKnownResolution, runPipeline } from "./pipelines.js";
import type { SupportStorage } from "./storage.js";
import { assertAnonymized, triageHeuristic, triageWithModel } from "./triage.js";
import type { TriageVerdict } from "./triage.js";

/*
 * Ingestion du support (2.18) : boîte support@ -> Object Storage -> ticket ->
 * triage -> pipeline -> brouillon en file de validation opérateur.
 * - Idempotence par Message-ID (re-poll = zéro doublon).
 * - Expéditeur identifié via From -> user -> memberships ; inconnu = file
 *   générique, ZÉRO contexte tenant, zéro LLM.
 * - JAMAIS un corps d'e-mail dans les logs ni en base (Object Storage seul).
 * - P1 -> push immédiat à l'opérateur (payload minimal 2.17, jamais le sujet).
 */

export interface IncomingAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface IncomingMail {
  messageId: string;
  from: string;
  subject: string;
  body: string;
  inReplyTo?: string | undefined;
  /** Signal SPF/DKIM éventuel des en-têtes (jamais une preuve). */
  authSignal?: string | undefined;
  attachments: IncomingAttachment[];
}

/** Source de courrier injectable : IMAP réel en prod, factice en test. */
export interface SupportMailSource {
  listNew(): Promise<IncomingMail[]>;
  markProcessed(messageId: string): Promise<void>;
}

export interface SupportIngestDeps {
  storage: SupportStorage;
  source: SupportMailSource;
  /** UserIds opérateurs (allowlist plateforme) — destinataires du push P1. */
  operatorUserIds: string[];
  /** Injectables en test. */
  triage?: typeof triageWithModel;
  pipeline?: typeof runPipeline;
  onError?: (name: string) => void;
}

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const NO_SENDER = { tenantId: null, userId: null, tenantName: null };

/**
 * Un From se FALSIFIE (audit 2.18) : le contexte tenant n'est accordé que si
 * SPF/DKIM attestent un `pass` ALIGNÉ sur le domaine de l'expéditeur — sinon
 * l'e-mail est traité en inconnu (zéro contexte, zéro LLM), même si
 * l'adresse correspond à un utilisateur connu.
 */
export function senderAuthenticated(mail: Pick<IncomingMail, "from" | "authSignal">): boolean {
  const signal = mail.authSignal?.toLowerCase() ?? "";
  const domain = mail.from.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || !signal) return false;
  const pass = signal.includes("dkim=pass") || signal.includes("spf=pass");
  return pass && signal.includes(domain);
}

/** From (authentifié) -> user connu -> memberships. */
async function identifySender(
  from: string,
): Promise<{ tenantId: string | null; userId: string | null; tenantName: string | null }> {
  const email = from.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return NO_SENDER;
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { tenantId: true, tenant: { select: { name: true } } },
    take: 2,
  });
  // Multi-organisations (expert-comptable) : PAS de contexte tenant — on ne
  // devine jamais quel dossier client est concerné, l'opérateur tranche.
  if (memberships.length !== 1) return { ...NO_SENDER, userId: user.id };
  const membership = memberships[0]!;
  return { tenantId: membership.tenantId, userId: user.id, tenantName: membership.tenant.name };
}

/** Push P1 -> opérateurs : payload minimal via la brique 2.17 (catégorie
 * support). UNE notification par opérateur (sa plus ancienne organisation =
 * la sienne), jamais un fan-out sur toutes ses memberships. */
async function notifyOperatorsP1(operatorUserIds: string[]): Promise<void> {
  for (const userId of operatorUserIds) {
    const membership = await prisma.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { tenantId: true },
    });
    if (membership) await recordPushEvent(membership.tenantId, [userId], "support");
  }
}

/**
 * Une passe d'ingestion. Retourne le nombre de tickets créés. Chaque e-mail
 * est isolé : un échec n'empêche ni les suivants ni le sweep global.
 */
export async function ingestSupportMailbox(deps: SupportIngestDeps): Promise<number> {
  const triage = deps.triage ?? triageWithModel;
  const pipeline = deps.pipeline ?? runPipeline;
  const onError = deps.onError ?? (() => undefined);
  const mails = await deps.source.listNew();
  let created = 0;

  for (const mail of mails) {
    try {
      if (!mail.messageId) continue;
      // Idempotence : déjà ingéré (re-poll, redémarrage) -> marquer et passer.
      const existing = await withOps((tx) =>
        tx.supportTicket.findUnique({ where: { messageId: mail.messageId }, select: { id: true } }),
      );
      if (existing) {
        await deps.source.markProcessed(mail.messageId);
        continue;
      }

      // Corps + pièces jointes -> Object Storage (jamais en base, jamais loggés).
      const baseKey = `support/${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
      const objectKeys: string[] = [`${baseKey}/body.txt`];
      await deps.storage.put(
        `${baseKey}/body.txt`,
        new TextEncoder().encode(mail.body),
        "text/plain; charset=utf-8",
      );
      for (const [index, attachment] of mail.attachments.entries()) {
        if (attachment.content.byteLength > ATTACHMENT_MAX_BYTES) continue;
        if (!ATTACHMENT_MIMES.has(attachment.contentType)) continue;
        const key = `${baseKey}/piece-${index + 1}`;
        await deps.storage.put(key, attachment.content, attachment.contentType);
        objectKeys.push(key);
      }

      const sender = senderAuthenticated(mail) ? await identifySender(mail.from) : NO_SENDER;

      // Triage : LLM souverain (tenant identifié) ou heuristique (inconnu).
      let verdict: TriageVerdict;
      try {
        verdict = sender.tenantId
          ? await triage(sender.tenantId, { subject: mail.subject, body: mail.body })
          : triageHeuristic();
      } catch {
        verdict = { ...triageHeuristic(), summary: "triage indisponible — à trier" };
      }

      const ticket = await withOps((tx) =>
        tx.supportTicket.create({
          data: {
            messageId: mail.messageId,
            fromEmail: mail.from.trim().toLowerCase(),
            subject: mail.subject.slice(0, 500),
            tenantId: sender.tenantId,
            userId: sender.userId,
            origin: verdict.origin,
            level: verdict.level,
            status: verdict.spam ? "SPAM" : "TRIE",
            objectKeys,
            authSignal: mail.authSignal ?? null,
            inReplyTo: mail.messageId,
          },
        }),
      );
      created += 1;

      if (!verdict.spam) {
        // Recueil : problème connu -> résolution canonique fournie au pipeline.
        const knownResolution = await findKnownResolution(verdict.summary);
        try {
          const draft = await pipeline(
            verdict.origin,
            {
              tenantId: sender.tenantId,
              subject: mail.subject,
              body: mail.body,
              summary: verdict.summary,
              knownResolution,
            },
            // Garde d'anonymisation : l'adresse, son domaine, le nom du tenant.
            [mail.from, mail.from.split("@")[1] ?? "", sender.tenantName ?? ""],
          );
          // Garde d'anonymisation AVANT persistance (audit 2.18) : un
          // brouillon ou rapport qui cite l'adresse, son domaine ou le tenant
          // (injection « recopie ce texte ») ne rentre JAMAIS en base ops —
          // le ticket reste TRIE, l'opérateur traite depuis le corps stocké.
          assertAnonymized(
            `${draft.draftReply} ${JSON.stringify(draft.report ?? {})}`,
            [mail.from, mail.from.split("@")[1] ?? "", sender.tenantName ?? ""],
          );
          await withOps((tx) =>
            tx.supportTicket.update({
              where: { id: ticket.id },
              data: {
                status: "BROUILLON_PRET",
                draftReply: draft.draftReply,
                ...(draft.report ? { agentReport: draft.report as Prisma.InputJsonValue } : {}),
              },
            }),
          );
        } catch (error) {
          // Brouillon indisponible (LLM down, garde d'anonymisation) : le
          // ticket reste TRIE — l'opérateur traite à la main. Nom d'erreur
          // seulement, jamais le contenu.
          onError(error instanceof Error ? error.name : "Error");
        }

        if (verdict.level === "P1") {
          await notifyOperatorsP1(deps.operatorUserIds).catch((error: unknown) =>
            onError(error instanceof Error ? error.name : "Error"),
          );
        }
      }

      await deps.source.markProcessed(mail.messageId);
    } catch (error) {
      onError(error instanceof Error ? error.name : "Error");
    }
  }
  return created;
}
