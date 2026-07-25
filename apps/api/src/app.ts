import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma, withTenant } from "@nodaq/db";
import { CreateNoteInput, TenantId } from "@nodaq/shared";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

/**
 * Extrait le tenant du header `x-tenant-id` (validé Zod).
 * Provisoire (ticket 0.1) : remplacé par le tenant de la session au ticket 0.2 (auth).
 */
async function requireTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = TenantId.safeParse(request.headers["x-tenant-id"]);
  if (!parsed.success) {
    await reply
      .code(400)
      .send({ error: "header x-tenant-id manquant ou invalide (uuid attendu)" });
    return;
  }
  request.tenantId = parsed.data;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", db: "ok" };
  });

  app.get("/notes", { preHandler: requireTenant }, async (request) => {
    return withTenant(request.tenantId, (tx) =>
      tx.note.findMany({ orderBy: { createdAt: "desc" } }),
    );
  });

  app.post("/notes", { preHandler: requireTenant }, async (request, reply) => {
    const parsed = CreateNoteInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload invalide", details: parsed.error.flatten() });
    }
    const note = await withTenant(request.tenantId, (tx) =>
      tx.note.create({ data: { ...parsed.data, tenantId: request.tenantId } }),
    );
    return reply.code(201).send(note);
  });

  return app;
}
