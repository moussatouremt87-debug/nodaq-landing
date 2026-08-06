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
  // Plateforme de dématérialisation (2.4) — l'opérateur est un choix de
  // déploiement : sans URL configurée, le connecteur PDP refuse de se
  // construire en production (aucun dépôt vers une destination inconnue).
  { name: "PDP_BASE_URL", required: false },
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

/*
 * Rétention de la file de validation (art. 5.1.e) — INCONDITIONNEL.
 *
 * À la différence du push, ce balayage n'a pas de « si configuré » : une
 * obligation de conservation limitée ne dépend pas d'une clé VAPID. Une
 * installation qui oublierait de le brancher garderait des brouillons
 * nominatifs pour toujours sans que rien ne le signale.
 */
const { startRetentionSweep } = await import("./retention.js");
const stopRetentionSweep = startRetentionSweep({
  // Nom de l'erreur ET tenant concerné (un UUID opaque, pas une donnée) :
  // sans le second, un tenant dont la rétention échoue à chaque passage reste
  // introuvable, et donc jamais réparé.
  onError: (name, tenantId) => app.log.warn({ err: name, tenantId }, "retention sweep failed"),
  // Compteurs SEULEMENT — jamais un payload, jamais un nom de client. Sans
  // cette ligne, un balayage qui rejette cent propositions serait
  // indistinguable d'une perte de données.
  onSweep: (result) => {
    // Tronqué = des lignes n'ont PAS été examinées : ça se dit toujours, même
    // quand le passage n'a rien modifié par ailleurs.
    if (result.truncated) {
      app.log.warn(
        {
          tenants: result.tenants,
          scanned: result.scanned,
          // NOMMÉS, même raison que le tenant d'une erreur : un tenant affamé
          // seulement compté « quelque part » est signalé mais introuvable,
          // donc jamais réparé.
          truncatedTenants: result.truncatedTenants,
        },
        "retention sweep truncated — some actions were not examined",
      );
    }
    /*
     * Troncature des CONVERSATIONS, annoncée à part.
     *
     * Partager le drapeau ferait journaliser « some actions were not
     * examined » pour un arriéré qui ne concerne que des transcriptions —
     * un message qui envoie chercher au mauvais endroit.
     */
    if (result.conversationsTruncated) {
      app.log.warn(
        { tenants: result.tenants, conversationsSupprimees: result.conversationsSupprimees },
        "retention sweep truncated — transcripts remain",
      );
    }
    // Un passage qui n'a RIEN fait ne se journalise pas… sauf s'il a échoué
    // quelque part : un échec silencieux et un tenant propre se ressemblent
    // trop pour qu'on les confonde.
    if (
      result.rejected === 0 &&
      result.reduced === 0 &&
      // La SEULE opération destructive du balayage : l'omettre ici faisait
      // sortir en silence un passage ayant supprimé cinquante mille
      // transcriptions sans en réduire une seule. Le seul compteur qui compte
      // des lignes DÉTRUITES était le seul à ne pas être journalisé.
      result.conversationsSupprimees === 0 &&
      result.outboxSupprimes === 0 &&
      result.failed === 0 &&
      result.unclassified.length === 0
    ) {
      return;
    }
    app.log.info(
      {
        tenants: result.tenants,
        failed: result.failed,
        scanned: result.scanned,
        rejected: result.rejected,
        reduced: result.reduced,
        conversationsSupprimees: result.conversationsSupprimees,
        outboxSupprimes: result.outboxSupprimes,
        // Types d'action qu'aucun groupe ne réclame : ils ne sont PAS balayés,
        // et le dire est la seule façon qu'ils finissent par l'être.
        unclassified: result.unclassified,
      },
      "retention sweep",
    );
  },
});
app.addHook("onClose", async () => stopRetentionSweep());

/*
 * RELAIS DU BUS D'ÉVÉNEMENTS (4.4, PR A).
 *
 * En processus, comme les deux ordonnanceurs ci-dessus, et pour la même
 * raison : l'outbox porte déjà l'atomicité et le rejeu que le ticket
 * attendait d'une file. Une file distribuée s'introduira le jour où un
 * consommateur devra tourner HORS de l'API.
 *
 * Cadence à 2 s : le critère du ticket est « écrans à jour en moins de 5 s »,
 * et le relais ne lit que les non-transmis, servis par un index partiel.
 */
const { startOutboxRelay } = await import("./outboxRelay.js");
const stopOutboxRelay = startOutboxRelay({
  onError: (name, tenantId) => app.log.warn({ err: name, tenantId }, "outbox relay failed"),
  // Des compteurs, jamais un type d'objet ni un identifiant : ce journal
  // tourne toutes les 2 s, et il ne doit rien apprendre à qui le lit.
  onRelay: (result) => {
    if (result.failed > 0 || result.truncated) {
      app.log.warn(
        { relayed: result.relayed, failed: result.failed, truncated: result.truncated },
        "outbox relay incomplete",
      );
    }
  },
});
app.addHook("onClose", async () => stopOutboxRelay());

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
