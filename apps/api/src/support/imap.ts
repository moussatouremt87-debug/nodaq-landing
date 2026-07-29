import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { IncomingMail, SupportMailSource } from "./ingest.js";

/*
 * Source IMAP réelle (2.18) : boîte support@ chez un fournisseur FR/UE (OVH,
 * Infomaniak… — configurée au coffre, jamais en dur). Chaque passe ouvre une
 * connexion courte : pas de connexion longue durée à surveiller. Les messages
 * traités sont marqués \Seen — l'idempotence par Message-ID en base couvre
 * les redémarrages entre la lecture et le marquage.
 */

export function createImapMailSource(
  env: NodeJS.ProcessEnv = process.env,
): SupportMailSource | null {
  const host = env.SUPPORT_IMAP_HOST;
  const user = env.SUPPORT_IMAP_USER;
  const pass = env.SUPPORT_IMAP_PASSWORD;
  if (!host || !user || !pass) return null;
  const config = { host, user, pass, port: Number(env.SUPPORT_IMAP_PORT ?? 993) };

  async function withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: { user: config.user, pass: config.pass },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  return {
    async listNew(): Promise<IncomingMail[]> {
      return withInbox(async (client) => {
        const mails: IncomingMail[] = [];
        for await (const message of client.fetch({ seen: false }, { source: true, uid: true })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          const from = parsed.from?.value[0]?.address ?? "";
          if (!from) continue;
          const rawAuth = parsed.headers.get("authentication-results");
          // Peut être multiple (un par relais) : on concatène, borné — c'est
          // un SIGNAL d'alignement SPF/DKIM, pas une donnée à conserver longue.
          const authHeader = Array.isArray(rawAuth)
            ? rawAuth.map(String).join(" ; ")
            : rawAuth;
          mails.push({
            messageId: parsed.messageId ?? `imap-uid-${message.uid}`,
            from,
            subject: parsed.subject ?? "",
            body: parsed.text ?? "",
            inReplyTo: parsed.messageId ?? undefined,
            authSignal: typeof authHeader === "string" ? authHeader.slice(0, 500) : undefined,
            attachments: (parsed.attachments ?? []).map((attachment) => ({
              filename: attachment.filename ?? "piece-jointe",
              contentType: attachment.contentType,
              content: new Uint8Array(attachment.content),
            })),
          });
        }
        return mails;
      });
    },
    async markProcessed(messageId: string): Promise<void> {
      await withInbox(async (client) => {
        const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
        if (Array.isArray(uids) && uids.length > 0) {
          await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
        }
      });
    },
  };
}
