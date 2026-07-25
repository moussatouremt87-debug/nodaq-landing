import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma, withTenant } from "@nodaq/db";
import { CreateNoteInput, TenantId } from "@nodaq/shared";
import { auth } from "./auth.js";

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthSession;
    tenantId: string;
  }
}

/** Convert Fastify headers to Web Headers (expected by better-auth). */
function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.append(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/*
 * Authorization chain (CLAUDE.md) — every business route runs, in order:
 *   requireAuth        -> validates the better-auth session, else 401
 *   resolveTenant      -> target tenant = active organization of the session
 *   requireMembership  -> checks IN DB that the user belongs to that tenant, else 403
 *   withTenant(id, …)  -> opens data access (RLS as the last rampart)
 * The tenantId NEVER comes from client input: switching tenants goes through
 * POST /api/auth/organization/set-active (which itself checks membership).
 */

async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: toWebHeaders(request) });
  if (!session) {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }
  request.authSession = session;
}

async function resolveTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const active = TenantId.safeParse(request.authSession.session.activeOrganizationId);
  if (!active.success) {
    await reply.code(400).send({
      error: "no active organization",
      hint: "create one (POST /api/auth/organization/create) or select one (POST /api/auth/organization/set-active)",
    });
    return;
  }
  request.tenantId = active.data;
}

async function requireMembership(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Session ≠ authorization: re-check membership in DB even though set-active
  // already did — a stale or tampered session must never open another tenant.
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: request.tenantId, userId: request.authSession.user.id } },
    select: { id: true },
  });
  if (!membership) {
    await reply.code(403).send({ error: "not a member of the active organization" });
    return;
  }
}

const businessRoute = [requireAuth, resolveTenant, requireMembership];

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // better-auth handler: /api/auth/* (sign-up/sign-in email, session, sign-out,
  // organization/create, organization/set-active, invitations...)
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

  /** Current session: user, active organization and memberships. */
  app.get("/me", { preHandler: [requireAuth] }, async (request) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: request.authSession.user.id },
      select: { tenantId: true, role: true, tenant: { select: { name: true, slug: true } } },
    });
    return {
      userId: request.authSession.user.id,
      activeOrganizationId: request.authSession.session.activeOrganizationId ?? null,
      memberships,
    };
  });

  app.get("/notes", { preHandler: businessRoute }, async (request) => {
    return withTenant(request.tenantId, (tx) =>
      tx.note.findMany({ orderBy: { createdAt: "desc" } }),
    );
  });

  app.post("/notes", { preHandler: businessRoute }, async (request, reply) => {
    const parsed = CreateNoteInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid payload", details: parsed.error.flatten() });
    }
    const note = await withTenant(request.tenantId, (tx) =>
      tx.note.create({ data: { ...parsed.data, tenantId: request.tenantId } }),
    );
    return reply.code(201).send(note);
  });

  return app;
}
