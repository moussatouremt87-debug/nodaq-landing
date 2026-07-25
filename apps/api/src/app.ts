import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, withTenant } from "@nodaq/db";
import { CreateNoteInput, TenantId } from "@nodaq/shared";
import { auth } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    tenantId: string;
  }
}

/** Convertit les headers Fastify en Headers Web (attendu par better-auth). */
function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.append(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/** Session requise : 401 sinon. Pose request.userId. */
async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: toWebHeaders(request) });
  if (!session) {
    await reply.code(401).send({ error: "authentification requise" });
    return;
  }
  request.userId = session.user.id;
}

/**
 * Tenant depuis la SESSION (ticket 0.2) — le header x-tenant-id n'est plus une
 * source de vérité : il ne sert qu'à choisir parmi les memberships du user
 * connecté, et est refusé (403) s'il pointe un tenant auquel il n'appartient pas.
 * Sans header : le tenant unique du user (400 s'il en a plusieurs, 403 s'il n'en a aucun).
 */
async function requireTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.sent) return;

  const memberships = await prisma.membership.findMany({
    where: { userId: request.userId },
    select: { tenantId: true },
  });
  if (memberships.length === 0) {
    await reply.code(403).send({ error: "aucun tenant : créez-en un via POST /tenants" });
    return;
  }

  const requested = request.headers["x-tenant-id"];
  if (requested !== undefined) {
    const parsed = TenantId.safeParse(requested);
    if (!parsed.success) {
      await reply.code(400).send({ error: "x-tenant-id invalide (uuid attendu)" });
      return;
    }
    if (!memberships.some((m) => m.tenantId === parsed.data)) {
      await reply.code(403).send({ error: "vous n'êtes pas membre de ce tenant" });
      return;
    }
    request.tenantId = parsed.data;
    return;
  }

  if (memberships.length > 1) {
    await reply
      .code(400)
      .send({ error: "plusieurs tenants : précisez x-tenant-id", tenants: memberships });
    return;
  }
  request.tenantId = memberships[0]!.tenantId;
}

const CreateTenantInput = z.object({ name: z.string().min(1).max(200) });

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Montage better-auth : /api/auth/* (sign-up/sign-in email, session, sign-out...)
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      const url = new URL(request.url, auth.options.baseURL);
      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers: toWebHeaders(request),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(webRequest);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      await reply.send(response.body ? await response.text() : null);
    },
  });

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", db: "ok" };
  });

  /** Session courante + memberships (pratique pour le front et le debug). */
  app.get("/me", { preHandler: requireUser }, async (request) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: request.userId },
      select: { tenantId: true, role: true, tenant: { select: { name: true } } },
    });
    return { userId: request.userId, memberships };
  });

  /** Crée un tenant et rattache le user connecté comme OWNER. */
  app.post("/tenants", { preHandler: requireUser }, async (request, reply) => {
    const parsed = CreateTenantInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "payload invalide", details: parsed.error.flatten() });
    }
    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { name: parsed.data.name } });
      await tx.membership.create({
        data: { tenantId: t.id, userId: request.userId, role: "OWNER" },
      });
      return t;
    });
    return reply.code(201).send(tenant);
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
