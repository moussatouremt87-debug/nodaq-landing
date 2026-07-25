import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ComptaAgent } from "@nodaq/agent-runtime";
import type { ToolsetContext } from "@nodaq/agent-runtime";
import { prisma, withTenant } from "@nodaq/db";
import { CreateNoteInput, TenantId, Uuid } from "@nodaq/shared";
import { auth } from "./auth.js";
import { defaultExecutors } from "./executors.js";
import type { ExecutorRegistry } from "./executors.js";

export interface BuildAppOptions {
  /** Executors for approved pending actions (injectable in tests). */
  executors?: ExecutorRegistry;
  /** Extra agent context (fake service URLs in tests). */
  agentContext?: Partial<Omit<ToolsetContext, "tenantId">>;
}

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthSession;
    tenantId: string;
    membershipRole: string;
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
    select: { id: true, role: true },
  });
  if (!membership) {
    await reply.code(403).send({ error: "not a member of the active organization" });
    return;
  }
  request.membershipRole = membership.role;
}

const businessRoute = [requireAuth, resolveTenant, requireMembership];

/** Sensitive actions gate (CLAUDE.md): role checked from the DB membership. */
function requireRole(roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!roles.includes(request.membershipRole)) {
      await reply.code(403).send({ error: `requires role: ${roles.join(" | ")}` });
    }
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const executors = options.executors ?? defaultExecutors;
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

  /*
   * 1-click validation queue (CLAUDE.md rule #4). Agents PREPARE pending
   * actions; only a HUMAN approves or rejects here — validatedBy records who,
   * for legal attribution. State machine: pending -> approved | rejected.
   * Approval/rejection = sensitive action => OWNER only.
   */

  // List = metadata ONLY: payloads carry confidential drafts/invoice data,
  // reserved to the owner-gated detail endpoint (RGPD audit 1.5 — the
  // `accountant` role is a delegated third party).
  app.get("/pending-actions", { preHandler: businessRoute }, async (request) => {
    return withTenant(request.tenantId, (tx) =>
      tx.pendingAction.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          type: true,
          status: true,
          requestedBy: true,
          validatedBy: true,
          validatedAt: true,
          createdAt: true,
        },
      }),
    );
  });

  app.get(
    "/pending-actions/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      const action = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.findUnique({ where: { id: params.data.id } }),
      );
      if (!action) return reply.code(404).send({ error: "pending action not found" });
      return reply.send(action);
    },
  );

  const decide = (decision: "approved" | "rejected") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: {
            status: decision,
            validatedBy: request.authSession.user.id,
            validatedAt: new Date(),
          },
        }),
      );
      if (count === 0) {
        // RLS-scoped: an id from another tenant is indistinguishable from a
        // missing one (404); an already-processed one is a conflict (409).
        const exists = await withTenant(request.tenantId, (tx) =>
          tx.pendingAction.findUnique({ where: { id: params.data.id }, select: { status: true } }),
        );
        if (!exists) return reply.code(404).send({ error: "pending action not found" });
        return reply.code(409).send({ error: `already ${exists.status}` });
      }
      const updated = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.findUnique({
          where: { id: params.data.id },
          select: { id: true, type: true, status: true, validatedBy: true, validatedAt: true },
        }),
      );
      return reply.send(updated);
    };

  app.post(
    "/pending-actions/:id/approve",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      // Atomic claim pending -> approved: exactly ONE approval wins, so the
      // execution below runs exactly once (double-approve => 409, no re-run).
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: {
            status: "approved",
            validatedBy: request.authSession.user.id,
            validatedAt: new Date(),
          },
        }),
      );
      if (count === 0) {
        const exists = await withTenant(request.tenantId, (tx) =>
          tx.pendingAction.findUnique({ where: { id: params.data.id }, select: { status: true } }),
        );
        if (!exists) return reply.code(404).send({ error: "pending action not found" });
        return reply.code(409).send({ error: `already ${exists.status}` });
      }

      // Execute AFTER human approval — the only place a prepared action runs.
      const action = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.findUniqueOrThrow({ where: { id: params.data.id } }),
      );
      const executor = executors[action.type];
      let outcome: { status: "executed" | "failed"; result: object };
      if (!executor) {
        outcome = { status: "failed", result: { error: "no-executor" } };
      } else {
        try {
          const result = await executor(action.payload, { tenantId: request.tenantId });
          outcome = { status: "executed", result: (result ?? {}) as object };
        } catch (error) {
          // Error NAME only — an executor error must never echo payload content.
          outcome = {
            status: "failed",
            result: { error: error instanceof Error ? error.name : "Error" },
          };
        }
      }
      const updated = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.update({
          where: { id: params.data.id },
          data: { status: outcome.status, executedAt: new Date(), result: outcome.result },
          select: {
            id: true,
            type: true,
            status: true,
            validatedBy: true,
            validatedAt: true,
            executedAt: true,
            result: true,
          },
        }),
      );
      return reply.send(updated);
    },
  );

  app.post(
    "/pending-actions/:id/reject",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    decide("rejected"),
  );

  /**
   * Conversation with the Compta/Direction virtual employee — SSE stream.
   * The agent runtime is constructed HERE, from the session's active
   * organization, AFTER the full auth chain: the tenant provenance follow-up
   * from tickets 1.2/1.3 is closed at this exact line.
   */
  app.post("/employees/compta/chat", { preHandler: businessRoute }, async (request, reply) => {
    const body = z
      .object({ message: z.string().min(1).max(10_000), conversationId: Uuid.optional() })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: object): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const agentRuntime = new ComptaAgent({
      ...options.agentContext,
      tenantId: request.tenantId,
      requestedBy: request.authSession.user.id,
    });
    try {
      await agentRuntime.run(body.data.message, {
        ...(body.data.conversationId ? { conversationId: body.data.conversationId } : {}),
        onEvent: send,
      });
    } catch (error) {
      // Error NAME only in the stream — never content.
      send({ type: "error", name: error instanceof Error ? error.name : "Error" });
    } finally {
      reply.raw.end();
    }
    return reply;
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
