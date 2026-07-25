import { prisma } from "@nodaq/db";
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "arrêt gracieux");
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
