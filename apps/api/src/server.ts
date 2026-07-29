import { injectSecrets } from "@nodaq/secrets";

/*
 * Bootstrap order matters: secrets are injected into process.env BEFORE any
 * module that reads env at import time (@nodaq/db, ./auth.js) gets loaded —
 * hence the dynamic imports below.
 * Dev/CI: EnvSecretProvider (gitignored .env). Staging/prod: Scaleway Secret
 * Manager (SCW_SECRET_KEY set), and the required secrets become mandatory.
 */
const isProd = process.env.NODE_ENV === "production";
// Least privilege (audit 0.4): the runtime NEVER holds the admin DSN —
// DATABASE_URL is for migrations/tests only; prisma runs on APP_DATABASE_URL
// (app_user, NOSUPERUSER, RLS enforced).
await injectSecrets([
  { name: "AUTH_SECRET", required: isProd },
  { name: "APP_DATABASE_URL", required: isProd },
  { name: "AUTH_BASE_URL", required: false },
  // Notifications push (2.17) — optionnelles : absentes, la feature dégrade
  // (routes 503, aucun envoi), le reste de l'app est intact.
  { name: "PUSH_VAPID_PUBLIC_KEY", required: false },
  { name: "PUSH_VAPID_PRIVATE_KEY", required: false },
  { name: "PUSH_VAPID_SUBJECT", required: false },
  // Canal support (2.18) — même dégradation propre : sans boîte IMAP ou sans
  // Object Storage, le canal est inactif ; sans TEM, l'envoi répond 503.
  { name: "SUPPORT_IMAP_HOST", required: false },
  { name: "SUPPORT_IMAP_PORT", required: false },
  { name: "SUPPORT_IMAP_USER", required: false },
  { name: "SUPPORT_IMAP_PASSWORD", required: false },
  { name: "SUPPORT_S3_ENDPOINT", required: false },
  { name: "SUPPORT_S3_BUCKET", required: false },
  { name: "SUPPORT_S3_ACCESS_KEY", required: false },
  { name: "SUPPORT_S3_SECRET_KEY", required: false },
  { name: "SUPPORT_FROM_EMAIL", required: false },
  { name: "OPS_OPERATOR_USER_IDS", required: false },
  { name: "SUPPORT_TEM_SECRET_KEY", required: false },
]);

const { buildApp } = await import("./app.js");
const { prisma } = await import("@nodaq/db");
const { createWebPushSender, startPushSweep } = await import("./push.js");

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

// Dispatch push : sweep périodique en process (Postgres porte l'état de
// regroupement — pas de Redis provisionné ; l'envoyeur est injectable).
const pushSender = createWebPushSender();
if (pushSender) {
  const stopPushSweep = startPushSweep({
    // Un sender par canal (interface commune) — FCM/APNS rejoindront le
    // registre avec les app stores (T.11).
    senders: { WEBPUSH: pushSender },
    // Nom de l'erreur SEULEMENT — jamais un contenu dans les logs.
    onError: (name) => app.log.warn({ err: name }, "push sweep failed"),
  });
  app.addHook("onClose", async () => stopPushSweep());
  app.log.info("push sweep started");
} else {
  app.log.info("push notifications not configured (no VAPID keys) — disabled");
}

// Canal support (2.18) : polling IMAP -> Object Storage -> triage -> brouillons.
// Tout est optionnel : boîte OU stockage absents = canal inactif, app intacte.
const { createImapMailSource } = await import("./support/imap.js");
const { createSupportStorage } = await import("./support/storage.js");
const { ingestSupportMailbox } = await import("./support/ingest.js");
const supportSource = createImapMailSource();
const supportStorage = createSupportStorage();
if (supportSource && supportStorage) {
  let ingesting = false;
  const supportTimer = setInterval(() => {
    if (ingesting) return;
    ingesting = true;
    void ingestSupportMailbox({
      storage: supportStorage,
      source: supportSource,
      operatorUserIds: (process.env.OPS_OPERATOR_USER_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
      // Nom d'erreur SEULEMENT — jamais un contenu d'e-mail dans les logs.
      onError: (name) => app.log.warn({ err: name }, "support ingest error"),
    })
      .catch((error: unknown) =>
        app.log.warn(
          { err: error instanceof Error ? error.name : "Error" },
          "support ingest failed",
        ),
      )
      .finally(() => {
        ingesting = false;
      });
  }, 90_000);
  supportTimer.unref();
  app.addHook("onClose", async () => clearInterval(supportTimer));
  app.log.info("support mailbox polling started");
} else {
  app.log.info("support channel not configured (IMAP/storage) — disabled");
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "graceful shutdown");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  await prisma.$disconnect();
  process.exit(1);
}
