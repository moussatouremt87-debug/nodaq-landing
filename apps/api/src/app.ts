import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildToolset, ComptaAgent } from "@nodaq/agent-runtime";
import type { ToolsetContext } from "@nodaq/agent-runtime";
import { prisma, withTenant } from "@nodaq/db";
import {
  connectorSecretName,
  ConnectorType,
  PennylaneClient,
  QontoClient,
} from "@nodaq/mcp-connectors";
import { defaultWritableProvider } from "@nodaq/secrets";
import type { WritableSecretProvider } from "@nodaq/secrets";
import { CreateNoteInput, TenantId, Uuid } from "@nodaq/shared";
import { auth } from "./auth.js";
import { defaultExecutors } from "./executors.js";
import type { ExecutorRegistry } from "./executors.js";

export interface BuildAppOptions {
  /** Executors for approved pending actions (injectable in tests). */
  executors?: ExecutorRegistry;
  /** Extra agent context (fake service URLs in tests). */
  agentContext?: Partial<Omit<ToolsetContext, "tenantId">>;
  /** Writable vault for connector credentials (injectable in tests). */
  vault?: WritableSecretProvider;
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
  // ONE vault for the app: connector credentials are WRITTEN here (onboarding)
  // and READ back by the agent toolset — unless a test injects fakes.
  const vault = options.vault ?? defaultWritableProvider();
  const agentContext = { secretProvider: vault, ...options.agentContext };
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Last rampart against detail leaks: an unhandled error must never echo its
  // message (internal URLs, secret refs) to the client — name only, log full.
  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error(error);
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? Number(error.statusCode)
        : NaN;
    void reply
      .code(Number.isInteger(statusCode) && statusCode >= 400 ? statusCode : 500)
      .send({ error: error instanceof Error ? error.name : "InternalServerError" });
  });

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

  // Draft edit BEFORE decision (owner-only, still pending). The human can
  // rework the prepared text; ONLY `payload.draft` is writable — invoice
  // facts, risk score and extraction stay exactly as the agent produced
  // them, and the edit is attributed (draftEditedBy) for the audit trail.
  app.patch(
    "/pending-actions/:id/draft",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      const body = z
        .object({ draft: z.string().trim().min(1).max(20_000) })
        .strict()
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid draft" });
      }
      // The reply is sent AFTER withTenant returns: a 200 must mean the
      // edit is COMMITTED (the human then approves what is really stored).
      const outcome = await withTenant(request.tenantId, async (tx) => {
        const action = await tx.pendingAction.findUnique({
          where: { id: params.data.id },
          select: { status: true, payload: true },
        });
        if (!action) return { code: 404 as const, error: "pending action not found" };
        if (action.status !== "pending") {
          return { code: 409 as const, error: `already ${action.status}` };
        }
        const payload = action.payload as Record<string, unknown> | null;
        if (typeof payload?.draft !== "string") {
          return { code: 422 as const, error: "this action has no editable draft" };
        }
        // Append-only audit trail: the agent's original text is kept once
        // (machine vs human attribution must stay provable), every edit adds
        // a {by, at} entry — nothing is ever erased.
        const originalDraft =
          typeof payload.originalDraft === "string" ? payload.originalDraft : payload.draft;
        const draftEdits = Array.isArray(payload.draftEdits) ? payload.draftEdits : [];
        // Conditional update: if a decision slipped in since the read, the
        // status filter makes this a no-op and the conflict surfaces.
        const { count } = await tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: {
            payload: {
              ...payload,
              draft: body.data.draft,
              originalDraft,
              draftEdits: [
                ...draftEdits,
                { by: request.authSession.user.id, at: new Date().toISOString() },
              ],
            },
          },
        });
        if (count === 0) return { code: 409 as const, error: "already decided" };
        return { code: 200 as const };
      });
      if (outcome.code !== 200) {
        return reply.code(outcome.code).send({ error: outcome.error });
      }
      return reply.send({ id: params.data.id, status: "pending", draft: body.data.draft });
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
      ...agentContext,
      tenantId: request.tenantId,
      requestedBy: request.authSession.user.id,
      // The toolset filters owner-only tools (treasury) on this role.
      role: request.membershipRole,
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

  /*
   * Connector onboarding (ticket 1.8). Rule of the house: credentials go IN,
   * never OUT — stored in the vault under `connector/<tenantId>/<type>`,
   * referenced by name in the connector row, absent from every response.
   * OWNER only: connecting a tool grants the agent read access to the
   * company's books. Credentials are TESTED against the provider before
   * being stored (fail-closed on typos); failures are generic client-side.
   */

  const ConnectorCredentials = {
    pennylane: z.object({ apiKey: z.string().min(8).max(200) }).strict(),
    qonto: z
      .object({
        organizationSlug: z.string().min(1).max(100),
        secretKey: z.string().min(8).max(200),
      })
      .strict(),
  } as const;

  /**
   * Live credential check before vaulting. The provider response is DISCARDED
   * entirely — it only proves the key works; nothing from it is stored,
   * logged or returned. On failure the caller gets a constant 422; only the
   * error NAME reaches the server log (ops visibility without leaking).
   */
  async function testConnectorCredentials(
    type: ConnectorType,
    credentials: unknown,
    log: FastifyRequest["log"],
  ): Promise<boolean> {
    try {
      if (type === "pennylane") {
        const client = new PennylaneClient(
          ConnectorCredentials.pennylane.parse(credentials),
          agentContext.pennylaneBaseUrl,
        );
        await client.listCustomerInvoices({ limit: 1 });
      } else {
        const client = new QontoClient(
          ConnectorCredentials.qonto.parse(credentials),
          agentContext.qontoBaseUrl,
        );
        await client.getOrganization();
      }
      return true;
    } catch (error) {
      log.warn(
        { type, err: error instanceof Error ? error.name : "Error" },
        "connector credential test failed",
      );
      return false;
    }
  }

  // Metadata only — the credentialsRef itself stays server-side.
  app.get("/connectors", { preHandler: businessRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.connector.findMany({
        orderBy: { createdAt: "asc" },
        select: { type: true, status: true, createdAt: true, updatedAt: true },
      }),
    );
    return { connectors: rows };
  });

  app.post(
    "/connectors",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const body = z
        .object({ type: ConnectorType, credentials: z.record(z.unknown()) })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid payload" });
      const parsed = ConnectorCredentials[body.data.type].safeParse(body.data.credentials);
      if (!parsed.success) return reply.code(400).send({ error: "invalid credentials format" });

      if (!(await testConnectorCredentials(body.data.type, parsed.data, request.log))) {
        // Generic on purpose: no provider status code, no detail.
        return reply.code(422).send({ error: "connection test failed" });
      }

      const secretName = connectorSecretName(request.tenantId, body.data.type);
      await vault.set(secretName, JSON.stringify(parsed.data));
      let row;
      try {
        row = await withTenant(request.tenantId, async (tx) => {
          // One connector per type: replacing = rotating the credentials.
          await tx.connector.deleteMany({ where: { type: body.data.type } });
          return tx.connector.create({
            data: { tenantId: request.tenantId, type: body.data.type, credentialsRef: secretName },
            select: { type: true, status: true, createdAt: true },
          });
        });
      } catch (error) {
        // No orphan credentials: if the row cannot be written, the secret
        // (unreachable by any future DELETE) is purged before failing.
        await vault.delete(secretName).catch(() => undefined);
        throw error;
      }
      return reply.code(201).send(row);
    },
  );

  app.delete(
    "/connectors/:type",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ type: ConnectorType }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "unknown connector type" });
      // Secret FIRST (droit à l'effacement) : if the vault delete fails the
      // row survives, so a retry purges again — never the other way around,
      // which would strand credentials in the vault with no row to reach them.
      await vault.delete(connectorSecretName(request.tenantId, params.data.type));
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.connector.deleteMany({ where: { type: params.data.type } }),
      );
      if (count === 0) return reply.code(404).send({ error: "connector not configured" });
      return reply.code(204).send();
    },
  );

  /**
   * Cockpit v0 (ticket 1.7) — KPIs of the virtual employees' work. Counts are
   * metadata-only (visible to every member); the treasury forecast is the
   * tenant's aggregate financial picture, reserved to the OWNER (same
   * delegated-third-party reasoning as the pending-action detail, audit 1.5).
   */
  app.get("/cockpit/kpis", { preHandler: businessRoute }, async (request) => {
    const byStatus = await withTenant(request.tenantId, (tx) =>
      tx.pendingAction.groupBy({ by: ["status"], _count: { _all: true } }),
    );
    const pendingActions: Record<string, number> = {};
    for (const row of byStatus) pendingActions[row.status] = row._count._all;
    const conversations = await withTenant(request.tenantId, (tx) => tx.agentConversation.count());

    // Treasury via the SAME tenant-bound toolset as the agent (read-only,
    // OWNER-only — enforced by the toolset's role gate AND skipped here).
    // Any failure (no Qonto connector, service down) yields null — the cockpit
    // degrades; only the error NAME reaches the logs, nothing reaches the client.
    let treasury: unknown = null;
    if (request.membershipRole === "owner") {
      let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
      try {
        toolset = await buildToolset({
          ...agentContext,
          tenantId: request.tenantId,
          role: request.membershipRole,
        });
        treasury = JSON.parse(await toolset.execute("compute_treasury_forecast", {}));
      } catch (error) {
        request.log.warn(
          { err: error instanceof Error ? error.name : "Error" },
          "cockpit treasury unavailable",
        );
        treasury = null;
      } finally {
        await toolset?.close().catch(() => undefined);
      }
    }
    return { pendingActions, conversations, treasury };
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
