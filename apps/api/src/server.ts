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
  const stopPushSweep = startPushSweep({ sender: pushSender });
  app.addHook("onClose", async () => stopPushSweep());
  app.log.info("push sweep started");
} else {
  app.log.info("push notifications not configured (no VAPID keys) — disabled");
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
