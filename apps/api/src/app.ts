import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildToolset, ComptaAgent } from "@nodaq/agent-runtime";
import type { ToolsetContext } from "@nodaq/agent-runtime";
import { prisma, Prisma, withOps, withTenant } from "@nodaq/db";
import { deriveFixedAssets, deriveReceivables, parseFec } from "@nodaq/fec";
import {
  BridgeClient,
  connectorSecretName,
  ConnectorNotConfiguredError,
  ConnectorType,
  FEC_CONNECTOR_STATUS,
  FEC_CONNECTOR_TYPE,
  getBankClient,
  PennylaneClient,
  QontoClient,
} from "@nodaq/mcp-connectors";
import type { BankClient } from "@nodaq/mcp-connectors";
import { defaultWritableProvider } from "@nodaq/secrets";
import type { WritableSecretProvider } from "@nodaq/secrets";
import {
  ASSET_CATEGORIES,
  CAPITALIZATION_THRESHOLD_CENTS,
  CreateNoteInput,
  estimateIsImpact,
  buildDepreciationPlan,
  renewalWall,
  TenantId,
  Uuid,
} from "@nodaq/shared";
import type { RegistryAsset } from "@nodaq/shared";
import { auth } from "./auth.js";
import { DOC_TYPES, extractDocumentFields, matchTransactions } from "./classeur.js";
import type { DocExtraction } from "./classeur.js";
import { defaultExecutors } from "./executors.js";
import type { ExecutorRegistry } from "./executors.js";
import {
  isAllowedPushEndpoint,
  markPushSeen,
  MAX_PUSH_DEVICES_PER_USER,
  PushCategorySchema,
  PushChannelSchema,
  recordPushEvent,
  tenantOwnerIds,
} from "./push.js";
import { createSupportStorage } from "./support/storage.js";
import type { SupportStorage } from "./support/storage.js";
import { createTemMailer } from "./support/tem.js";
import type { SupportMailer } from "./support/tem.js";
import { assertAnonymized, SupportOrigin } from "./support/triage.js";

export interface BuildAppOptions {
  /** Executors for approved pending actions (injectable in tests). */
  executors?: ExecutorRegistry;
  /** Extra agent context (fake service URLs in tests). */
  agentContext?: Partial<Omit<ToolsetContext, "tenantId">>;
  /** Writable vault for connector credentials (injectable in tests). */
  vault?: WritableSecretProvider;
  /** Object Storage du support (2.18) — factice en test, S3 sinon. */
  supportStorage?: SupportStorage | null;
  /** Envoi des réponses support (2.18) — factice en test, Scaleway TEM sinon. */
  supportMailer?: SupportMailer | null;
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

  // Push doorbell (2.17): one more pending action -> the tenant's OWNERS (the
  // validators) get an "actions" event, grouped by the dispatch window.
  const notifyPendingAction = async (tenantId: string): Promise<void> => {
    await recordPushEvent(tenantId, await tenantOwnerIds(tenantId), "actions");
  };

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
      // Display name only (greeting in the cockpit) — never an identifier.
      name: request.authSession.user.name ?? null,
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
    // Opening the validation queue = the "actions" push events are SEEN:
    // counter resets, re-notification unlocked (anti-spam rule of 2.17).
    // AWAITED : en fire-and-forget, le marquage pouvait s'exécuter APRÈS un
    // événement arrivé juste ensuite et l'effacer (course constatée en CI).
    await markPushSeen(request.tenantId, request.authSession.user.id, "actions").catch(
      () => undefined,
    );
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
          const result = await executor(action.payload, {
            tenantId: request.tenantId,
            userId: request.authSession.user.id,
          });
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
      // Push doorbell (2.17): a prepared pending_action notifies the OWNERS
      // (the validators). Fire-and-forget — a push failure must never break
      // the chat; and no data crosses this callback by design.
      onPendingAction: () => {
        void notifyPendingAction(request.tenantId).catch((error: unknown) => {
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "push record failed",
          );
        });
      },
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
    // Agrégateur DSP2 (2.15) : le userUuid est l'utilisateur Bridge dont la
    // banque est déjà reliée (le flux Bridge Connect hébergé viendra après).
    bridge: z
      .object({
        clientId: z.string().min(1).max(200),
        clientSecret: z.string().min(8).max(200),
        userUuid: z.string().min(1).max(100),
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
      } else if (type === "bridge") {
        const client = new BridgeClient(
          ConnectorCredentials.bridge.parse(credentials),
          agentContext.bridgeBaseUrl,
        );
        await client.testConnection();
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

  /*
   * Import FEC (ticket 2.14) — le « connecteur fichier » universel (art.
   * A47 A-1 du LPF). Le FEC est une donnée CONFIDENTIELLE par nature (journal
   * comptable complet) : parsé en mémoire, JAMAIS loggé, jamais renvoyé au
   * client ; seuls des compteurs et avertissements sortent. Le fichier brut
   * n'est PAS conservé (minimisation — V1) : seule l'empreinte SHA-256 sert
   * l'idempotence ; un nouvel import remplace intégralement le précédent
   * (jamais d'ingestion partielle : le parseur rejette en bloc).
   */

  // Métadonnées du dernier import — visibles de tout membre (compteurs only).
  app.get("/connectors/fec", { preHandler: businessRoute }, async (request) => {
    const lastImport = await withTenant(request.tenantId, (tx) =>
      tx.fecImport.findFirst({
        orderBy: { importedAt: "desc" },
        select: {
          importedAt: true,
          fileName: true,
          entryCount: true,
          invoiceCount: true,
          overdueCount: true,
        },
      }),
    );
    return { imported: lastImport !== null, lastImport };
  });

  // Le parser binaire est CANTONNÉ à cette route (plugin encapsulé) : le
  // reste de l'API n'accepte pas de corps octet-stream.
  void app.register(async (fec) => {
    fec.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    fec.post(
      "/connectors/fec/import",
      {
        preHandler: [...businessRoute, requireRole(["owner"])],
        bodyLimit: 50 * 1024 * 1024,
      },
      async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply
            .code(400)
            .send({ error: "fichier FEC attendu (corps application/octet-stream)" });
        }

        const fileHash = createHash("sha256").update(body).digest("hex");
        // Parse + dérivation AVANT la transaction (aucun IO DB pendant).
        const parsed = parseFec(new Uint8Array(body));
        if (!parsed.ok) {
          // Numéros de ligne et messages génériques UNIQUEMENT — jamais le contenu.
          return reply.code(422).send({ error: "FEC invalide", details: parsed.errors });
        }
        const derivation = deriveReceivables(parsed.entries);

        // Métadonnée d'affichage : nom de fichier assaini, optionnel.
        let fileName: string | null = null;
        const rawName = request.headers["x-fec-filename"];
        if (typeof rawName === "string") {
          try {
            fileName =
              decodeURIComponent(rawName)
                .replace(/[^\p{L}\p{N} ._()-]/gu, "")
                .slice(0, 120) || null;
          } catch {
            fileName = null;
          }
        }

        const warnings = [...parsed.warnings, ...derivation.warnings];
        type Outcome =
          | { kind: "already"; existing: { entryCount: number; customerCount: number; invoiceCount: number; overdueCount: number; overdueCents: bigint; warnings: unknown } }
          | { kind: "created" };
        let outcome: Outcome;
        try {
          outcome = await withTenant(
            request.tenantId,
            async (tx) => {
              // Sérialise les imports du tenant (verrou transactionnel) :
              // contrôle d'empreinte et écriture dans la MÊME transaction,
              // jamais deux imports vivants (audit RGPD 2.14).
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.tenantId} || ':fec-import'))`;
              const existing = await tx.fecImport.findUnique({
                where: { tenantId_fileHash: { tenantId: request.tenantId, fileHash } },
              });
              if (existing) return { kind: "already", existing } satisfies Outcome;
              // deleteMany SCOPÉ tenant : la RLS reste le dernier rempart,
              // pas la seule barrière (défense en profondeur).
              await tx.fecImport.deleteMany({ where: { tenantId: request.tenantId } });
              const imported = await tx.fecImport.create({
                data: {
                  tenantId: request.tenantId,
                  fileHash,
                  fileName,
                  entryCount: parsed.entries.length,
                  customerCount: derivation.customers.length,
                  invoiceCount: derivation.invoices.length,
                  overdueCount: derivation.overdueCount,
                  overdueCents: BigInt(derivation.overdueCents),
                  warnings,
                },
              });
              // Écriture par lots : borne la taille de chaque requête.
              for (let i = 0; i < derivation.invoices.length; i += 5000) {
                await tx.fecInvoice.createMany({
                  data: derivation.invoices.slice(i, i + 5000).map((invoice) => ({
                    tenantId: request.tenantId,
                    importId: imported.id,
                    customerRef: invoice.customerRef,
                    customerName: invoice.customerName,
                    number: invoice.number,
                    issuedDate: new Date(`${invoice.issuedDate}T00:00:00Z`),
                    dueDate: new Date(`${invoice.dueDate}T00:00:00Z`),
                    amountCents: BigInt(invoice.amountCents),
                    residualCents: BigInt(invoice.residualCents),
                    settled: invoice.settled,
                  })),
                });
              }
              // Le « connecteur fichier » : statut "file" (jamais "active" —
              // rien n'est connecté), posé UNIQUEMENT ici. Aucun secret associé.
              await tx.connector.upsert({
                where: {
                  tenantId_type: { tenantId: request.tenantId, type: FEC_CONNECTOR_TYPE },
                },
                update: { status: FEC_CONNECTOR_STATUS },
                create: {
                  tenantId: request.tenantId,
                  type: FEC_CONNECTOR_TYPE,
                  status: FEC_CONNECTOR_STATUS,
                  credentialsRef: connectorSecretName(request.tenantId, FEC_CONNECTOR_TYPE),
                },
              });
              return { kind: "created" } satisfies Outcome;
            },
            { timeoutMs: 30_000 },
          );
        } catch (error) {
          // Une erreur Prisma peut citer ses arguments (valeurs du FEC) : on
          // logue le NOM et des compteurs, jamais l'objet d'erreur complet.
          request.log.error(
            {
              err: error instanceof Error ? error.name : "Error",
              invoices: derivation.invoices.length,
            },
            "fec import failed",
          );
          return reply.code(500).send({ error: "import failed" });
        }

        if (outcome.kind === "already") {
          return reply.send({
            alreadyImported: true,
            entryCount: outcome.existing.entryCount,
            customerCount: outcome.existing.customerCount,
            invoiceCount: outcome.existing.invoiceCount,
            overdueCount: outcome.existing.overdueCount,
            overdueCents: Number(outcome.existing.overdueCents),
            warnings: z.array(z.string()).catch([]).parse(outcome.existing.warnings),
          });
        }
        // Immobilisations (2.19) : les comptes 2x/28x deviennent des
        // PROPOSITIONS en file de validation — jamais une insertion
        // silencieuse ; incohérences signalées dans le payload.
        let assetProposals = 0;
        const allProposals = deriveFixedAssets(parsed.entries);
        const proposals = allProposals.slice(0, 200);
        if (allProposals.length > 200) {
          warnings.push("propositions d'immobilisations tronquées à 200");
        }
        try {
          if (proposals.length > 0) {
            assetProposals = await withTenant(request.tenantId, async (tx) => {
              let count = 0;
              for (const proposal of proposals) {
              const sourceRef = `fec:${proposal.accountNum}`;
              const existingAsset = await tx.fixedAsset.findFirst({
                where: { source: "FEC", sourceRef },
                select: { id: true },
              });
              if (existingAsset) continue;
              const pendingProposal = await tx.pendingAction.findFirst({
                where: {
                  type: "create_fixed_asset",
                  status: "pending",
                  payload: { path: ["sourceRef"], equals: sourceRef },
                },
                select: { id: true },
              });
              if (pendingProposal) continue;
              await tx.pendingAction.create({
                data: {
                  tenantId: request.tenantId,
                  type: "create_fixed_asset",
                  requestedBy: request.authSession.user.id,
                  employee: "compta",
                  payload: {
                    label: proposal.label,
                    category: proposal.category,
                    inServiceDate: proposal.inServiceDate,
                    baseCents: proposal.baseCents,
                    durationMonths: ASSET_CATEGORIES[proposal.category].defaultMonths,
                    method: "LINEAIRE",
                    source: "FEC",
                    sourceRef,
                    priorDepreciationCents: proposal.priorDepreciationCents,
                    warnings: proposal.warnings,
                  },
                },
              });
              count += 1;
            }
            return count;
          }, { timeoutMs: 30_000 });
            if (assetProposals > 0) {
              void notifyPendingAction(request.tenantId).catch(() => undefined);
            }
          }
        } catch (error) {
          // Même règle que l'import : une erreur Prisma peut citer ses
          // arguments (libellés/montants dérivés du FEC) — nom SEULEMENT,
          // et l'import lui-même reste acquis (les propositions attendront
          // un prochain import après purge).
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "fixed asset proposals failed",
          );
          warnings.push("propositions d'immobilisations indisponibles (réessayez après purge FEC)");
        }
        return reply.code(201).send({
          alreadyImported: false,
          entryCount: parsed.entries.length,
          customerCount: derivation.customers.length,
          invoiceCount: derivation.invoices.length,
          overdueCount: derivation.overdueCount,
          overdueCents: derivation.overdueCents,
          fixedAssetProposals: assetProposals,
          warnings,
        });
      },
    );
  });

  // Droit à l'effacement (RGPD art. 17) : purge des données dérivées du FEC
  // (imports + factures via cascade) et du connecteur fichier. Owner only.
  app.delete(
    "/connectors/fec",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const removed = await withTenant(request.tenantId, async (tx) => {
        const { count } = await tx.fecImport.deleteMany({
          where: { tenantId: request.tenantId },
        });
        await tx.connector.deleteMany({ where: { type: FEC_CONNECTOR_TYPE } });
        return count;
      });
      if (removed === 0) return reply.code(404).send({ error: "no fec import" });
      return reply.code(204).send();
    },
  );

  /*
   * Classeur documentaire photo (ticket 2.16). La photo (confidentielle) vit
   * en base sous RLS ; l'extraction passe par route() (tier souverain vision,
   * catégorie confidentiel par construction) ; le rapprochement score les
   * transactions bancaires. Capture/correction : tout membre (l'employé de
   * terrain photographie). Rapprochement (données bancaires) et effacement :
   * owner uniquement — même raisonnement tiers-délégué que la trésorerie.
   */

  const DOC_SELECT = {
    id: true,
    fileName: true,
    mimeType: true,
    byteSize: true,
    docType: true,
    status: true,
    extraction: true,
    originalExtraction: true,
    corrections: true,
    matchedTransactionId: true,
    matchedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const; // jamais `photo` dans une liste — servie par la route dédiée

  /** Formats photo acceptés, détectés sur les OCTETS (jamais l'extension). */
  function sniffImageMime(buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length > 8 && buffer.subarray(0, 8).equals(pngMagic)) return "image/png";
    if (
      buffer.length > 12 &&
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP"
    ) {
      return "image/webp";
    }
    return null;
  }

  app.get("/classeur/documents", { preHandler: businessRoute }, async (request) => {
    const documents = await withTenant(request.tenantId, (tx) =>
      tx.classeurDocument.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
        select: DOC_SELECT,
      }),
    );
    return { documents };
  });

  // Le parser binaire est CANTONNÉ à cette route (plugin encapsulé).
  void app.register(async (classeur) => {
    classeur.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    classeur.post(
      "/classeur/documents",
      // onRequest (pas preHandler) : l'auth est vérifiée AVANT que Fastify ne
      // bufferise le corps — un anonyme ne coûte jamais 8 Mo d'allocation.
      { onRequest: businessRoute, bodyLimit: 8 * 1024 * 1024 },
      async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: "photo attendue (corps application/octet-stream)" });
        }
        // Quota par tenant : borne le stockage (≤ ~4 Go) ET les appels vision
        // facturés — un membre ne peut pas boucler indéfiniment.
        const documentCount = await withTenant(request.tenantId, (tx) =>
          tx.classeurDocument.count(),
        );
        if (documentCount >= 500) {
          return reply
            .code(409)
            .send({ error: "quota du classeur atteint (500 documents) — supprimez d'abord" });
        }
        const mimeType = sniffImageMime(body);
        if (!mimeType) {
          return reply.code(415).send({ error: "format non pris en charge (JPEG, PNG ou WebP)" });
        }
        const sha256 = createHash("sha256").update(body).digest("hex");

        // Métadonnée d'affichage : nom de fichier assaini, optionnel.
        let fileName: string | null = null;
        const rawName = request.headers["x-doc-filename"];
        if (typeof rawName === "string") {
          try {
            fileName =
              decodeURIComponent(rawName)
                .replace(/[^\p{L}\p{N} ._()-]/gu, "")
                .slice(0, 120) || null;
          } catch {
            fileName = null;
          }
        }

        // Dédup AVANT l'appel modèle : re-photographier le même fichier ne
        // coûte ni extraction ni stockage.
        const existing = await withTenant(request.tenantId, (tx) =>
          tx.classeurDocument.findUnique({
            where: { tenantId_sha256: { tenantId: request.tenantId, sha256 } },
            select: DOC_SELECT,
          }),
        );
        if (existing) return reply.send({ alreadyImported: true, document: existing });

        // Extraction via le tier souverain vision — AVANT la transaction (pas
        // d'IO DB pendant l'appel réseau). Un échec modèle n'empêche pas le
        // classement : le document est stocké, les champs restent à saisir.
        let extraction: DocExtraction | null = null;
        try {
          extraction = await extractDocumentFields(request.tenantId, `classeur-${randomUUID()}`, {
            mimeType,
            base64: body.toString("base64"),
          });
        } catch (error) {
          // Nom d'erreur uniquement — jamais le contenu du document.
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "classeur extraction failed",
          );
        }

        try {
          const document = await withTenant(request.tenantId, (tx) =>
            tx.classeurDocument.create({
              data: {
                tenantId: request.tenantId,
                fileName: fileName ?? "",
                mimeType,
                byteSize: body.length,
                sha256,
                photo: new Uint8Array(body),
                ...(extraction
                  ? {
                      docType: extraction.docType,
                      extraction,
                      originalExtraction: extraction,
                    }
                  : {}),
              },
              select: DOC_SELECT,
            }),
          );
          // Immobilisations (2.19) : facture d'équipement au-dessus du seuil
          // -> SUGGESTION « immobiliser ? » en file de validation. JAMAIS
          // automatique : la frontière charge/immo est une décision de gestion.
          // Seuil ET base amortissable en HT UNIQUEMENT (audit 2.19) : un
          // TTC amorti gonflerait la base de la TVA — pas de repli TTC.
          const htCents =
            extraction && extraction.totalExclTax !== null
              ? Math.round(extraction.totalExclTax * 100)
              : null;
          if (
            extraction &&
            extraction.docType === "facture_fournisseur" &&
            htCents !== null &&
            htCents >= CAPITALIZATION_THRESHOLD_CENTS
          ) {
            await withTenant(request.tenantId, (tx) =>
              tx.pendingAction.create({
                data: {
                  tenantId: request.tenantId,
                  type: "create_fixed_asset",
                  requestedBy: request.authSession.user.id,
                  employee: "compta",
                  payload: {
                    label: extraction.supplierName
                      ? `Équipement ${extraction.supplierName}`
                      : "Équipement (facture photographiée)",
                    category: "materiel",
                    inServiceDate:
                      extraction.docDate ?? new Date().toISOString().slice(0, 10),
                    baseCents: htCents,
                    durationMonths: ASSET_CATEGORIES.materiel.defaultMonths,
                    method: "LINEAIRE",
                    source: "DOCUMENT",
                    sourceRef: `classeur:${document.id}`,
                    priorDepreciationCents: 0,
                    warnings: ["catégorie et durée proposées — à ajuster avant validation"],
                  },
                },
              }),
            ).catch((error: unknown) =>
              request.log.warn(
                { err: error instanceof Error ? error.name : "Error" },
                "classeur asset suggestion failed",
              ),
            );
          }
          // Doorbell 2.17 : le document traité notifie SON auteur (compteur
          // seul — jamais le contenu), regroupé avec les autres actions.
          void recordPushEvent(request.tenantId, [request.authSession.user.id], "actions").catch(
            (error: unknown) => {
              request.log.warn(
                { err: error instanceof Error ? error.name : "Error" },
                "push record failed",
              );
            },
          );
          return reply.code(201).send({ alreadyImported: false, document });
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.name : "Error" },
            "classeur upload failed",
          );
          return reply.code(500).send({ error: "upload failed" });
        }
      },
    );
  });

  app.get(
    "/classeur/documents/:id/photo",
    { preHandler: businessRoute },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const document = await withTenant(request.tenantId, (tx) =>
        tx.classeurDocument.findUnique({
          where: { id },
          select: { photo: true, mimeType: true },
        }),
      );
      if (!document) return reply.code(404).send({ error: "not found" });
      return reply
        .header("content-type", document.mimeType)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", "inline")
        .send(Buffer.from(document.photo));
    },
  );

  // Correction des champs extraits (apprentissage V1) : l'extraction d'origine
  // est FIGÉE, chaque correction est journalisée en append-only — c'est le
  // futur jeu d'apprentissage. Statut => "verifie".
  const CorrectionBody = z
    .object({
      docType: z.enum(DOC_TYPES).optional(),
      supplierName: z.string().max(300).nullable().optional(),
      pieceNumber: z.string().max(120).nullable().optional(),
      docDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      currency: z.string().max(10).nullable().optional(),
      totalExclTax: z.number().finite().nullable().optional(),
      totalTax: z.number().finite().nullable().optional(),
      totalInclTax: z.number().finite().nullable().optional(),
    })
    .strict();

  app.patch("/classeur/documents/:id", { preHandler: businessRoute }, async (request, reply) => {
    const { id } = z.object({ id: Uuid }).parse(request.params);
    const parsed = CorrectionBody.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "invalid correction" });
    }
    const fields = parsed.data;

    let updated: unknown;
    try {
      updated = await withTenant(request.tenantId, async (tx) => {
        const document = await tx.classeurDocument.findUnique({
          where: { id },
          select: { extraction: true, corrections: true, docType: true, status: true },
        });
        if (!document) return null;
        // Append-only FAIL-CLOSED : un historique corrompu (pas un tableau)
        // ne doit JAMAIS être remplacé silencieusement — on refuse d'écrire.
        if (!Array.isArray(document.corrections)) {
          throw new Error("corrections history is not an array");
        }
        if (document.corrections.length >= 200) return "cap" as const;
        const extraction = {
          ...(typeof document.extraction === "object" && document.extraction !== null
            ? document.extraction
            : {}),
          ...fields,
        };
        const corrections = [
          ...document.corrections,
          { by: request.authSession.user.id, at: new Date().toISOString(), fields },
        ] as Prisma.InputJsonValue;
        return tx.classeurDocument.update({
          where: { id },
          data: {
            extraction,
            corrections,
            docType: fields.docType ?? document.docType,
            // Un document rapproché RESTE rapproché : corriger un champ ne
            // défait pas silencieusement le rapprochement fait par l'owner.
            status: document.status === "rapproche" ? "rapproche" : "verifie",
          },
          select: DOC_SELECT,
        });
      });
    } catch (error) {
      // Une erreur Prisma peut citer ses arguments (champs du justificatif) :
      // nom d'erreur uniquement, jamais l'objet complet.
      request.log.error(
        { err: error instanceof Error ? error.name : "Error" },
        "classeur correction failed",
      );
      return reply.code(500).send({ error: "correction failed" });
    }
    if (updated === null) return reply.code(404).send({ error: "not found" });
    if (updated === "cap") {
      return reply.code(409).send({ error: "trop de corrections sur ce document" });
    }
    return { document: updated };
  });

  // Rapprochement bancaire — owner only (labels/montants de transactions).
  app.get(
    "/classeur/documents/:id/candidates",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const document = await withTenant(request.tenantId, (tx) =>
        tx.classeurDocument.findUnique({ where: { id }, select: { extraction: true } }),
      );
      if (!document) return reply.code(404).send({ error: "not found" });
      const extraction = z
        .object({ totalInclTax: z.number().nullable().catch(null), docDate: z.string().nullable().catch(null) })
        .catch({ totalInclTax: null, docDate: null })
        .parse(document.extraction ?? {});

      // Banque agnostique (2.15) : Qonto direct, sinon agrégateur Bridge.
      let bank: BankClient;
      try {
        bank = await getBankClient(request.tenantId);
      } catch (error) {
        if (error instanceof ConnectorNotConfiguredError) {
          return { candidates: [], reason: "no-bank" };
        }
        throw error;
      }
      const { transactions } = await bank.listTransactions({ perPage: 100 });
      return {
        candidates: matchTransactions(
          extraction,
          transactions.map((tx) => ({
            transaction_id: tx.transaction_id ?? null,
            id: tx.id ?? null,
            amount_cents: tx.amount_cents ?? null,
            side: tx.side ?? null,
            settled_at: tx.settled_at ?? null,
            label: tx.label ?? null,
          })),
        ),
      };
    },
  );

  const MatchBody = z
    .object({ transactionId: z.string().min(1).max(200).nullable() })
    .strict();

  app.post(
    "/classeur/documents/:id/match",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const parsed = MatchBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid match" });
      const { transactionId } = parsed.data;

      let updated: unknown;
      try {
        updated = await withTenant(request.tenantId, async (tx) => {
          const exists = await tx.classeurDocument.findUnique({
            where: { id },
            select: { id: true },
          });
          if (!exists) return null;
          return tx.classeurDocument.update({
            where: { id },
            data: transactionId
              ? { matchedTransactionId: transactionId, matchedAt: new Date(), status: "rapproche" }
              : { matchedTransactionId: null, matchedAt: null, status: "verifie" },
            select: DOC_SELECT,
          });
        });
      } catch (error) {
        request.log.error(
          { err: error instanceof Error ? error.name : "Error" },
          "classeur match failed",
        );
        return reply.code(500).send({ error: "match failed" });
      }
      if (!updated) return reply.code(404).send({ error: "not found" });
      return { document: updated };
    },
  );

  // Droit à l'effacement (art. 17) — owner only, photo comprise.
  app.delete(
    "/classeur/documents/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.classeurDocument.deleteMany({ where: { id, tenantId: request.tenantId } }),
      );
      if (count === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );

  /*
   * Suivi des stocks (ticket 3.2). Le stock n'est pas une donnée financière :
   * tout membre le consulte et l'ajuste (l'employé de terrain sort du matériel
   * du dépôt) ; le RÉFÉRENTIEL (création, seuils, suppression) est owner.
   * Chaque ajustement passe par un mouvement append-only — la quantité ne se
   * modifie jamais directement.
   */

  const STOCK_SELECT = {
    id: true,
    name: true,
    sku: true,
    unit: true,
    quantity: true,
    alertThreshold: true,
    updatedAt: true,
  } as const;

  type StockRow = { quantity: number; alertThreshold: number };
  const stockView = <T extends StockRow>(item: T) => ({
    ...item,
    belowThreshold: item.alertThreshold > 0 && item.quantity <= item.alertThreshold,
  });

  app.get("/stocks", { preHandler: businessRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.stockItem.findMany({
        orderBy: { name: "asc" },
        take: 501,
        select: { ...STOCK_SELECT, unitCostCents: true },
      }),
    );
    // Troncature SIGNALÉE, jamais silencieuse (une alerte au-delà de la page
    // ne doit pas disparaître sans trace).
    const hasMore = rows.length > 500;
    // Coûts et valorisation (3.3) = donnée financière : OWNER only — un
    // membre voit les quantités, jamais les coûts de remplacement.
    const isOwner = request.membershipRole === "owner";
    return {
      items: rows.slice(0, 500).map((row) => {
        const { unitCostCents, ...base } = row;
        const view = stockView(base);
        return isOwner
          ? { ...view, unitCostCents, valueCents: row.quantity * unitCostCents }
          : view;
      }),
      hasMore,
    };
  });

  const StockItemBody = z
    .object({
      name: z.string().min(1).max(200),
      sku: z.string().max(100).nullable().optional(),
      unit: z.string().min(1).max(50).optional(),
      alertThreshold: z.number().int().min(0).max(1_000_000).optional(),
      // Coût de remplacement (3.3) — routes owner-only. Borné à 100 k€/unité :
      // combiné au plafond de quantité, le produit reste loin de
      // Number.MAX_SAFE_INTEGER (pas de perte de précision silencieuse).
      unitCostCents: z.number().int().min(0).max(10_000_000).optional(),
    })
    .strict();

  app.post(
    "/stocks",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const parsed = StockItemBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid stock item" });
      const { name, sku, unit, alertThreshold, unitCostCents } = parsed.data;
      try {
        const item = await withTenant(request.tenantId, (tx) =>
          tx.stockItem.create({
            data: {
              tenantId: request.tenantId,
              name,
              ...(sku !== undefined ? { sku } : {}),
              ...(unit !== undefined ? { unit } : {}),
              ...(alertThreshold !== undefined ? { alertThreshold } : {}),
              ...(unitCostCents !== undefined ? { unitCostCents } : {}),
            },
            select: { ...STOCK_SELECT, unitCostCents: true },
          }),
        );
        // Route owner : le coût et la valorisation peuvent sortir.
        return reply
          .code(201)
          .send({ item: { ...stockView(item), valueCents: item.quantity * item.unitCostCents } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return reply.code(409).send({ error: "an item with this name already exists" });
        }
        throw error;
      }
    },
  );

  app.patch(
    "/stocks/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const parsed = StockItemBody.partial().safeParse(request.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        return reply.code(400).send({ error: "invalid stock item" });
      }
      const fields = parsed.data;
      const data: Prisma.StockItemUpdateInput = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.sku !== undefined) data.sku = fields.sku;
      if (fields.unit !== undefined) data.unit = fields.unit;
      if (fields.alertThreshold !== undefined) data.alertThreshold = fields.alertThreshold;
      if (fields.unitCostCents !== undefined) data.unitCostCents = fields.unitCostCents;
      try {
        const item = await withTenant(request.tenantId, async (tx) => {
          const exists = await tx.stockItem.findUnique({ where: { id }, select: { id: true } });
          if (!exists) return null;
          return tx.stockItem.update({
            where: { id },
            data,
            select: { ...STOCK_SELECT, unitCostCents: true },
          });
        });
        if (!item) return reply.code(404).send({ error: "not found" });
        // Route owner : le coût et la valorisation peuvent sortir.
        return { item: { ...stockView(item), valueCents: item.quantity * item.unitCostCents } };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return reply.code(409).send({ error: "an item with this name already exists" });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/stocks/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.stockItem.deleteMany({ where: { id, tenantId: request.tenantId } }),
      );
      if (count === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );

  const MovementBody = z
    .object({
      delta: z
        .number()
        .int()
        .min(-1_000_000)
        .max(1_000_000)
        .refine((value) => value !== 0, { message: "delta must not be zero" }),
      reason: z.string().max(200).optional(),
    })
    .strict();

  // Plafond de quantité : évite le débordement INTEGER par entrées répétées.
  const MAX_STOCK_QUANTITY = 1_000_000_000;

  app.post(
    "/stocks/:id/movements",
    // L'expert-comptable (tiers délégué) consulte mais ne sort pas de matériel.
    { preHandler: [...businessRoute, requireRole(["owner", "member"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const parsed = MovementBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid movement" });
      const { delta, reason } = parsed.data;

      const outcome = await withTenant(request.tenantId, async (tx) => {
        const exists = await tx.stockItem.findUnique({ where: { id }, select: { id: true } });
        if (!exists) return null;
        // ATOMIQUE : plancher (0) et plafond appliqués DANS le même update
        // conditionnel — deux sorties concurrentes ne franchissent jamais le
        // zéro (audit RGPD 3.2), aucun read-modify-write en mémoire.
        const { count } = await tx.stockItem.updateMany({
          where: {
            id,
            quantity: {
              gte: delta < 0 ? -delta : 0,
              lte: MAX_STOCK_QUANTITY - Math.max(0, delta),
            },
          },
          data: { quantity: { increment: delta } },
        });
        if (count === 0) return "conflict" as const;
        await tx.stockMovement.create({
          data: {
            tenantId: request.tenantId,
            itemId: id,
            delta,
            reason: reason ?? null,
            createdBy: request.authSession.user.id,
          },
        });
        return tx.stockItem.findUnique({ where: { id }, select: STOCK_SELECT });
      });
      if (outcome === null) return reply.code(404).send({ error: "not found" });
      if (outcome === "conflict") {
        return reply.code(409).send({ error: "insufficient stock" });
      }
      return { item: stockView(outcome!) };
    },
  );

  app.get("/stocks/:id/movements", { preHandler: businessRoute }, async (request, reply) => {
    const { id } = z.object({ id: Uuid }).parse(request.params);
    const movements = await withTenant(request.tenantId, async (tx) => {
      const exists = await tx.stockItem.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return null;
      return tx.stockMovement.findMany({
        where: { itemId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, delta: true, reason: true, createdAt: true },
      });
    });
    if (movements === null) return reply.code(404).send({ error: "not found" });
    return { movements };
  });

  /**
   * Cockpit v0 (ticket 1.7) — KPIs of the virtual employees' work. Counts are
   * metadata-only (visible to every member); the treasury forecast is the
   * tenant's aggregate financial picture, reserved to the OWNER (same
   * delegated-third-party reasoning as the pending-action detail, audit 1.5).
   */
  app.get("/cockpit/kpis", { preHandler: businessRoute }, async (request) => {
    // Opening the cockpit = the "alerts" push events are seen (2.17) —
    // awaited (même course que la file de validation).
    await markPushSeen(request.tenantId, request.authSession.user.id, "alerts").catch(
      () => undefined,
    );
    const byStatus = await withTenant(request.tenantId, (tx) =>
      tx.pendingAction.groupBy({ by: ["status"], _count: { _all: true } }),
    );
    const pendingActions: Record<string, number> = {};
    for (const row of byStatus) pendingActions[row.status] = row._count._all;
    const conversations = await withTenant(request.tenantId, (tx) => tx.agentConversation.count());

    // Alertes stock (3.2) — métadonnée non financière, visible de tout membre.
    // Compté côté SQL (comparaison colonne à colonne, RLS scelle au tenant) :
    // jamais une troncature silencieuse du compteur.
    const stockAlertRows = await withTenant(request.tenantId, (tx) =>
      tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM stock_items
        WHERE alert_threshold > 0 AND quantity <= alert_threshold`,
    );
    const stockAlerts = stockAlertRows[0]?.count ?? 0;

    // Treasury via the SAME tenant-bound toolset as the agent (read-only,
    // OWNER-only — enforced by the toolset's role gate AND skipped here).
    // Any failure (no Qonto connector, service down) yields null — the cockpit
    // degrades; only the error NAME reaches the logs, nothing reaches the client.
    let treasury: unknown = null;
    let sales: unknown = null;
    if (request.membershipRole === "owner") {
      let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
      try {
        toolset = await buildToolset({
          ...agentContext,
          tenantId: request.tenantId,
          role: request.membershipRole,
        });
        // Chaque prévision dégrade indépendamment : pas de banque n'empêche
        // pas la prévision des ventes (factures), et réciproquement.
        try {
          treasury = JSON.parse(await toolset.execute("compute_treasury_forecast", {}));
        } catch (error) {
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "cockpit treasury unavailable",
          );
        }
        try {
          sales = JSON.parse(await toolset.execute("forecast_sales", {}));
        } catch (error) {
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "cockpit sales forecast unavailable",
          );
        }
      } catch (error) {
        request.log.warn(
          { err: error instanceof Error ? error.name : "Error" },
          "cockpit toolset unavailable",
        );
      } finally {
        await toolset?.close().catch(() => undefined);
      }
    }
    return { pendingActions, conversations, stockAlerts, treasury, sales };
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

  /*
   * Notifications push Web (2.17). Opt-in par appareil, préférences par type,
   * révocation — chaîne d'auth complète, subscription rattachée à l'user de
   * session. Les clés de subscription ENTRENT et ne ressortent jamais : les
   * réponses ne contiennent ni endpoint ni p256dh/auth (minimisation).
   * Sans clés VAPID au coffre, la feature dégrade en 503 « non configuré ».
   */
  const pushConfigured = (): boolean =>
    Boolean(process.env.PUSH_VAPID_PUBLIC_KEY && process.env.PUSH_VAPID_PRIVATE_KEY);

  const PUSH_DEVICE_SELECT = {
    id: true,
    channel: true,
    userAgent: true,
    actionsEnabled: true,
    alertsEnabled: true,
    createdAt: true,
    lastUsedAt: true,
  } as const;

  app.get("/push/config", { preHandler: businessRoute }, async () => ({
    configured: pushConfigured(),
    vapidPublicKey: process.env.PUSH_VAPID_PUBLIC_KEY ?? null,
  }));

  const PushSubscriptionBody = z
    .object({
      // Anti-SSRF (audit 2.17) : le serveur émettra des requêtes vers cette
      // URL — https + services push des navigateurs UNIQUEMENT.
      endpoint: z.string().url().max(1_000).refine(isAllowedPushEndpoint, {
        message: "endpoint must be a browser push service",
      }),
      keys: z
        .object({ p256dh: z.string().min(1).max(300), auth: z.string().min(1).max(200) })
        .strict(),
      userAgent: z.string().max(200).optional(),
      // WEBPUSH par défaut ; FCM/APNS réservés aux apps stores (T.11) —
      // refusés tant qu'aucun sender n'existe pour eux.
      channel: PushChannelSchema.optional(),
      actionsEnabled: z.boolean().optional(),
      alertsEnabled: z.boolean().optional(),
    })
    .strict()
    .refine((body) => (body.channel ?? "WEBPUSH") === "WEBPUSH", {
      message: "channel not available yet",
    });

  app.post("/push/subscriptions", { preHandler: businessRoute }, async (request, reply) => {
    if (!pushConfigured()) {
      return reply.code(503).send({ error: "notifications push non configurées" });
    }
    const parsed = PushSubscriptionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    const { endpoint, keys, userAgent, channel, actionsEnabled, alertsEnabled } = parsed.data;
    const userId = request.authSession.user.id;
    try {
      const subscription = await withTenant(request.tenantId, async (tx) => {
        // Plafond anti-amplification : chaque appareil = des envois réseau
        // du serveur à chaque sweep.
        const deviceCount = await tx.pushSubscription.count({ where: { userId } });
        if (deviceCount >= MAX_PUSH_DEVICES_PER_USER) {
          throw Object.assign(new Error("device limit"), { statusCode: 429 });
        }
        const existing = await tx.pushSubscription.findFirst({ where: { endpoint } });
        if (existing) {
          // Même appareil re-souscrit (clés régénérées par le navigateur) :
          // il doit appartenir au même utilisateur — un endpoint = un
          // propriétaire, jamais de transfert silencieux.
          if (existing.userId !== userId) return null;
          return tx.pushSubscription.update({
            where: { id: existing.id },
            data: {
              p256dh: keys.p256dh,
              auth: keys.auth,
              // Persisté EXPLICITEMENT (audit) : le refine reste la garde
              // d'acceptation, la colonne dit toujours la vérité du canal.
              channel: channel ?? "WEBPUSH",
              ...(userAgent !== undefined ? { userAgent } : {}),
              ...(actionsEnabled !== undefined ? { actionsEnabled } : {}),
              ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
            },
            select: PUSH_DEVICE_SELECT,
          });
        }
        return tx.pushSubscription.create({
          data: {
            tenantId: request.tenantId,
            userId,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            channel: channel ?? "WEBPUSH",
            userAgent: userAgent ?? null,
            ...(actionsEnabled !== undefined ? { actionsEnabled } : {}),
            ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
          },
          select: PUSH_DEVICE_SELECT,
        });
      });
      if (!subscription) {
        // Message UNIQUE pour tous les conflits (audit 2.17) : ne confirme
        // jamais où ni par qui l'endpoint est déjà enregistré.
        return reply.code(409).send({ error: "appareil déjà enregistré" });
      }
      return reply.code(201).send(subscription);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "appareil déjà enregistré" });
      }
      if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
        return reply.code(429).send({ error: "limite d'appareils atteinte pour ce compte" });
      }
      throw error;
    }
  });

  // SES appareils uniquement : la liste est par utilisateur, pas par tenant.
  app.get("/push/subscriptions", { preHandler: businessRoute }, async (request) => {
    return withTenant(request.tenantId, (tx) =>
      tx.pushSubscription.findMany({
        where: { userId: request.authSession.user.id },
        orderBy: { createdAt: "desc" },
        select: PUSH_DEVICE_SELECT,
      }),
    );
  });

  const PushPrefsBody = z
    .object({ actionsEnabled: z.boolean().optional(), alertsEnabled: z.boolean().optional() })
    .strict()
    .refine((body) => body.actionsEnabled !== undefined || body.alertsEnabled !== undefined, {
      message: "at least one preference required",
    });

  app.patch("/push/subscriptions/:id", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const parsed = PushPrefsBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    const updated = await withTenant(request.tenantId, (tx) =>
      tx.pushSubscription.updateMany({
        // Scopé à l'utilisateur de session : on ne règle jamais l'appareil
        // d'un collègue, même owner.
        where: { id: params.data.id, userId: request.authSession.user.id },
        data: {
          ...(parsed.data.actionsEnabled !== undefined
            ? { actionsEnabled: parsed.data.actionsEnabled }
            : {}),
          ...(parsed.data.alertsEnabled !== undefined
            ? { alertsEnabled: parsed.data.alertsEnabled }
            : {}),
        },
      }),
    );
    if (updated.count === 0) return reply.code(404).send({ error: "unknown device" });
    return { updated: true };
  });

  app.delete("/push/subscriptions/:id", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const deleted = await withTenant(request.tenantId, (tx) =>
      tx.pushSubscription.deleteMany({
        where: { id: params.data.id, userId: request.authSession.user.id },
      }),
    );
    if (deleted.count === 0) return reply.code(404).send({ error: "unknown device" });
    return { revoked: true };
  });

  // Marquage explicite « j'ai vu » (le web l'appelle à l'ouverture de la file
  // de validation) — GET /pending-actions et /cockpit/kpis le font déjà.
  app.post("/push/seen", { preHandler: businessRoute }, async (request, reply) => {
    const parsed = z
      .object({ category: PushCategorySchema })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    await markPushSeen(request.tenantId, request.authSession.user.id, parsed.data.category);
    return { seen: true };
  });

  /*
   * ── Back-office support (2.18) ─────────────────────────────────────────────
   * Rôle plateforme OPERATOR = allowlist d'e-mails au coffre
   * (OPS_OPERATOR_EMAILS) — hors rôles tenant. Les tables ops (schéma `ops`)
   * ne sont accessibles QUE par ces routes ; un non-opérateur reçoit 404
   * (l'existence même du back-office n'est pas confirmée).
   * RÈGLE : rien ne part vers un client sans validation ici (envoi TEM), et
   * le corps d'un e-mail ne quitte l'Object Storage que vers l'opérateur.
   */
  const supportStorage =
    options.supportStorage !== undefined ? options.supportStorage : createSupportStorage();
  const supportMailer =
    options.supportMailer !== undefined ? options.supportMailer : createTemMailer();

  // Allowlist par USER ID (audit 2.18, bloquant) : une allowlist d'e-mails
  // serait revendicable par un simple sign-up sur une adresse non encore
  // enregistrée — les ids sont générés serveur, non forgeables.
  const operatorUserIds = (): string[] =>
    (process.env.OPS_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

  async function requireOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!operatorUserIds().includes(request.authSession.user.id)) {
      await reply.code(404).send({ error: "not found" });
    }
  }
  const operatorRoute = [requireAuth, requireOperator];

  const TICKET_SELECT = {
    id: true,
    fromEmail: true,
    subject: true,
    tenantId: true,
    origin: true,
    level: true,
    status: true,
    authSignal: true,
    inReplyTo: true,
    repliedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  app.get("/ops/support/tickets", { preHandler: operatorRoute }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(30).optional(),
        level: z.string().max(5).optional(),
        origin: z.string().max(30).optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    return withOps((tx) =>
      tx.supportTicket.findMany({
        where: {
          ...(query.data.status ? { status: query.data.status } : {}),
          ...(query.data.level ? { level: query.data.level } : {}),
          ...(query.data.origin ? { origin: query.data.origin } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: TICKET_SELECT,
      }),
    );
  });

  app.get("/ops/support/tickets/:id", { preHandler: operatorRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const ticket = await withOps((tx) =>
      tx.supportTicket.findUnique({
        where: { id: params.data.id },
        select: { ...TICKET_SELECT, draftReply: true, agentReport: true, objectKeys: true },
      }),
    );
    if (!ticket) return reply.code(404).send({ error: "unknown ticket" });
    return ticket;
  });

  // Corps original : lu depuis l'Object Storage, servi à l'OPÉRATEUR seul.
  app.get(
    "/ops/support/tickets/:id/body",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });
      if (!supportStorage) return reply.code(503).send({ error: "stockage non configuré" });
      const ticket = await withOps((tx) =>
        tx.supportTicket.findUnique({ where: { id: params.data.id }, select: { objectKeys: true } }),
      );
      const keys = z.array(z.string()).catch([]).parse(ticket?.objectKeys ?? []);
      const bodyKey = keys.find((key) => key.endsWith("/body.txt"));
      if (!bodyKey) return reply.code(404).send({ error: "no body" });
      const object = await supportStorage.get(bodyKey);
      if (!object) return reply.code(404).send({ error: "no body" });
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(Buffer.from(object.body));
    },
  );

  app.patch("/ops/support/tickets/:id", { preHandler: operatorRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const body = z
      .object({ draftReply: z.string().min(1).max(20_000) })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid payload" });
    try {
      const updated = await withOps((tx) =>
        tx.supportTicket.updateMany({
          where: { id: params.data.id, status: { in: ["TRIE", "BROUILLON_PRET"] } },
          data: { draftReply: body.data.draftReply, status: "BROUILLON_PRET" },
        }),
      );
      if (updated.count === 0) return reply.code(404).send({ error: "unknown ticket" });
      return { updated: true };
    } catch (error) {
      // Jamais l'erreur brute : une PrismaValidationError sérialiserait le
      // brouillon (contenu) dans les logs du handler global.
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "support draft update failed",
      );
      return reply.code(500).send({ error: "update failed" });
    }
  });

  // LA validation 1 clic : seul chemin d'envoi vers un client (jamais d'envoi
  // automatique — auto_reply n'existe qu'en flag documenté, OFF).
  app.post(
    "/ops/support/tickets/:id/send",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });
      if (!supportMailer) return reply.code(503).send({ error: "envoi non configuré (TEM)" });
      const ticket = await withOps((tx) =>
        tx.supportTicket.findUnique({ where: { id: params.data.id } }),
      );
      if (!ticket || !ticket.draftReply) return reply.code(404).send({ error: "no draft" });
      if (ticket.status !== "BROUILLON_PRET") {
        return reply.code(409).send({ error: "ticket not ready" });
      }
      await supportMailer.send({
        to: ticket.fromEmail,
        subject: ticket.subject.startsWith("Re:") ? ticket.subject : `Re: ${ticket.subject}`,
        text: ticket.draftReply,
        ...(ticket.inReplyTo ? { inReplyTo: ticket.inReplyTo } : {}),
      });
      await withOps((tx) =>
        tx.supportTicket.update({
          where: { id: ticket.id },
          data: { status: "REPONDU", repliedAt: new Date() },
        }),
      );
      return { sent: true };
    },
  );

  const ResolveBody = z
    .object({
      /** Incrémenter une entrée existante du recueil… */
      issueId: Uuid.optional(),
      /** …ou en proposer une nouvelle (anonymisée, garde vérifiée). */
      issue: z
        .object({
          title: z.string().min(1).max(200),
          symptoms: z.string().min(1).max(2_000),
          cause: z.string().max(2_000).default(""),
          resolution: z.string().max(2_000).default(""),
          origin: SupportOrigin,
        })
        .strict()
        .optional(),
    })
    .strict();

  app.post(
    "/ops/support/tickets/:id/resolve",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      const body = ResolveBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid payload" });
      }
      const ticket = await withOps((tx) =>
        tx.supportTicket.findUnique({ where: { id: params.data.id } }),
      );
      if (!ticket) return reply.code(404).send({ error: "unknown ticket" });

      let issueId: string | null = null;
      if (body.data.issueId) {
        const knownIssueId = body.data.issueId;
        const updated = await withOps((tx) =>
          tx.supportIssue.updateMany({
            where: { id: knownIssueId },
            data: { occurrences: { increment: 1 } },
          }),
        );
        if (updated.count === 0) return reply.code(404).send({ error: "unknown issue" });
        issueId = body.data.issueId;
      } else if (body.data.issue) {
        // Garde d'anonymisation : le recueil sert TOUS les tenants — jamais
        // l'adresse de l'expéditeur, son domaine ou le nom du tenant dedans.
        const tenant = ticket.tenantId
          ? await prisma.tenant.findUnique({
              where: { id: ticket.tenantId },
              select: { name: true },
            })
          : null;
        const text = `${body.data.issue.title} ${body.data.issue.symptoms} ${body.data.issue.cause} ${body.data.issue.resolution}`;
        try {
          assertAnonymized(text, [
            ticket.fromEmail,
            ticket.fromEmail.split("@")[1] ?? "",
            tenant?.name ?? "",
          ]);
        } catch {
          return reply
            .code(400)
            .send({ error: "entrée non anonymisée (adresse, domaine ou tenant présent)" });
        }
        const issue = await withOps((tx) => tx.supportIssue.create({ data: body.data.issue! }));
        issueId = issue.id;
      }

      await withOps((tx) =>
        tx.supportTicket.update({ where: { id: ticket.id }, data: { status: "RESOLU" } }),
      );
      return { resolved: true, issueId };
    },
  );

  app.get("/ops/support/issues", { preHandler: operatorRoute }, async () => {
    return withOps((tx) => tx.supportIssue.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }));
  });

  app.post(
    "/ops/support/issues/:id/validate",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });
      const updated = await withOps((tx) =>
        tx.supportIssue.updateMany({ where: { id: params.data.id }, data: { validated: true } }),
      );
      if (updated.count === 0) return reply.code(404).send({ error: "unknown issue" });
      return { validated: true };
    },
  );

  app.get("/ops/support/stats", { preHandler: operatorRoute }, async () => {
    const [byStatus, byLevel, issues] = await withOps(async (tx) => [
      await tx.supportTicket.groupBy({ by: ["status"], _count: { _all: true } }),
      await tx.supportTicket.groupBy({ by: ["level"], _count: { _all: true } }),
      await tx.supportIssue.count({ where: { validated: true } }),
    ] as const);
    return {
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      byLevel: Object.fromEntries(byLevel.map((row) => [row.level ?? "?", row._count._all])),
      validatedIssues: issues,
    };
  });

  /*
   * ── Immobilisations (2.19) ────────────────────────────────────────────────
   * Registre à visée trésorerie/décision : on CALCULE, on n'écrit JAMAIS
   * dans la comptabilité. OWNER-ONLY (patrimoine + valeurs financières).
   * L'impact IS est une ESTIMATION labellisée ; le mur de renouvellement est
   * un SCÉNARIO ; une dotation n'entre jamais comme décaissement.
   */
  const registryAsset = (row: {
    id: string;
    label: string;
    baseCents: bigint;
    inServiceDate: Date;
    durationMonths: number;
    method: string;
    status: string;
    renewalCostCents: bigint | null;
  }): RegistryAsset => ({
    id: row.id,
    label: row.label,
    baseCents: Number(row.baseCents),
    inServiceDate: row.inServiceDate,
    durationMonths: row.durationMonths,
    method: row.method === "DEGRESSIF" ? "DEGRESSIF" : "LINEAIRE",
    renewalCostCents: row.renewalCostCents === null ? null : Number(row.renewalCostCents),
    status: row.status,
  });

  const ownerRoute = [...businessRoute, requireRole(["owner"])];

  app.get("/immobilisations", { preHandler: ownerRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.findMany({
        orderBy: [{ status: "asc" }, { inServiceDate: "asc" }],
        take: 500,
      }),
    );
    const now = new Date();
    const year = now.getUTCFullYear();
    const assets = rows.map((row) => {
      const model = registryAsset(row);
      const plan = buildDepreciationPlan(model);
      // Reprise FEC 28x consommée (audit 2.19) : le cumul affiché est AU
      // MOINS celui des livres — la VNC recalculée ne contredit jamais un
      // amortissement déjà constaté par le comptable.
      const recomputed = plan.lines.filter((l) => l.year <= year).at(-1)?.cumulativeCents ?? 0;
      const cumulative = Math.min(
        model.baseCents,
        Math.max(recomputed, Number(row.priorDepreciationCents)),
      );
      const bookValue = model.baseCents - cumulative;
      return {
        id: row.id,
        label: row.label,
        category: row.category,
        inServiceDate: row.inServiceDate.toISOString().slice(0, 10),
        baseCents: Number(row.baseCents),
        durationMonths: row.durationMonths,
        method: row.method,
        source: row.source,
        status: row.status,
        renewalCostCents: row.renewalCostCents === null ? null : Number(row.renewalCostCents),
        bookValueCents: bookValue,
        wearRatio: model.baseCents > 0 ? cumulative / model.baseCents : 0,
        planEndYear: plan.lines.at(-1)?.year ?? null,
      };
    });
    const active = rows.filter((r) => r.status === "ACTIF").map(registryAsset);
    return {
      assets,
      totalBookValueCents: assets
        .filter((a) => a.status === "ACTIF")
        .reduce((sum, a) => sum + a.bookValueCents, 0),
      renewalWall: renewalWall(active, now, 24),
      isImpact: estimateIsImpact(active, now),
    };
  });

  app.get("/immobilisations/:id/plan", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const row = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.findUnique({ where: { id: params.data.id } }),
    );
    if (!row) return reply.code(404).send({ error: "unknown asset" });
    return { plan: buildDepreciationPlan(registryAsset(row)).lines };
  });

  const FixedAssetBody = z
    .object({
      label: z.string().min(1).max(200),
      category: z.enum(["informatique", "logiciel", "vehicule", "materiel", "mobilier", "agencement"]),
      inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      baseCents: z.number().int().min(1).max(10_000_000_000),
      durationMonths: z.number().int().min(1).max(600),
      method: z.enum(["LINEAIRE", "DEGRESSIF"]).default("LINEAIRE"),
    })
    .strict()
    // CGI 39 A : dégressif réservé aux catégories éligibles (config sourcée).
    .refine(
      (data) => data.method !== "DEGRESSIF" || ASSET_CATEGORIES[data.category].decliningAllowed,
      { message: "dégressif non admis pour cette catégorie" },
    );

  // Saisie MANUELLE : c'est déjà la décision humaine — création directe owner.
  app.post("/immobilisations", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = FixedAssetBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const asset = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.create({
        data: {
          tenantId: request.tenantId,
          label: parsed.data.label,
          category: parsed.data.category,
          inServiceDate: new Date(`${parsed.data.inServiceDate}T00:00:00Z`),
          baseCents: BigInt(parsed.data.baseCents),
          durationMonths: parsed.data.durationMonths,
          method: parsed.data.method,
          source: "MANUEL",
        },
        select: { id: true },
      }),
    );
    return reply.code(201).send({ id: asset.id });
  });

  const FixedAssetPatch = z
    .object({
      renewalCostCents: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
      status: z.enum(["ACTIF", "CEDE", "SORTI"]).optional(),
      disposedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "empty patch" })
    // Une cession/sortie sans date fausserait le plan : date obligatoire.
    .refine(
      (b) => !(b.status === "CEDE" || b.status === "SORTI") || typeof b.disposedAt === "string",
      { message: "disposedAt required when disposing" },
    );

  app.patch("/immobilisations/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const body = FixedAssetPatch.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid payload" });
    const updated = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.updateMany({
        where: { id: params.data.id },
        data: {
          ...(body.data.renewalCostCents !== undefined
            ? {
                renewalCostCents:
                  body.data.renewalCostCents === null ? null : BigInt(body.data.renewalCostCents),
              }
            : {}),
          ...(body.data.status !== undefined ? { status: body.data.status } : {}),
          ...(body.data.disposedAt !== undefined
            ? {
                disposedAt:
                  body.data.disposedAt === null
                    ? null
                    : new Date(`${body.data.disposedAt}T00:00:00Z`),
              }
            : {}),
        },
      }),
    );
    if (updated.count === 0) return reply.code(404).send({ error: "unknown asset" });
    return { updated: true };
  });

  /*
   * ── Plannings RH (3.5) ────────────────────────────────────────────────────
   * Données RH = PII (noms) + charge dérivée du CA : OWNER-ONLY de bout en
   * bout, comme le financier. Jamais un nom de salarié dans les logs.
   */
  const STAFF_SELECT = {
    id: true,
    name: true,
    role: true,
    weeklyHours: true,
    active: true,
  } as const;

  app.get("/rh", { preHandler: ownerRoute }, async (request) => {
    const [staff, absences] = await withTenant(request.tenantId, async (tx) => [
      await tx.staffMember.findMany({ orderBy: { name: "asc" }, take: 200, select: STAFF_SELECT }),
      await tx.staffAbsence.findMany({
        orderBy: { startDate: "desc" },
        take: 200,
        select: { id: true, staffId: true, type: true, startDate: true, endDate: true },
      }),
    ]);
    return { staff, absences };
  });

  const StaffBody = z
    .object({
      name: z.string().min(1).max(120),
      role: z.string().max(80).default(""),
      weeklyHours: z.number().int().min(0).max(80).default(35),
    })
    .strict();

  app.post("/rh/staff", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = StaffBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    try {
      const member = await withTenant(request.tenantId, (tx) =>
        tx.staffMember.create({
          data: { tenantId: request.tenantId, ...parsed.data },
          select: STAFF_SELECT,
        }),
      );
      return reply.code(201).send(member);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "salarié déjà enregistré" });
      }
      throw error;
    }
  });

  const StaffPatch = z
    .object({
      role: z.string().max(80).optional(),
      weeklyHours: z.number().int().min(0).max(80).optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, { message: "empty patch" });

  app.patch("/rh/staff/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const body = StaffPatch.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid payload" });
    const updated = await withTenant(request.tenantId, (tx) =>
      tx.staffMember.updateMany({
        where: { id: params.data.id },
        data: {
          ...(body.data.role !== undefined ? { role: body.data.role } : {}),
          ...(body.data.weeklyHours !== undefined ? { weeklyHours: body.data.weeklyHours } : {}),
          ...(body.data.active !== undefined ? { active: body.data.active } : {}),
        },
      }),
    );
    if (updated.count === 0) return reply.code(404).send({ error: "unknown staff member" });
    return { updated: true };
  });

  // Date STRICTEMENT calendaire (audit 3.5) : "2026-02-31" glisserait au
  // 3 mars et fausserait la capacité de deux mois — round-trip exigé.
  const IsoDay = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, { message: "invalid calendar date" });

  const AbsenceBody = z
    .object({
      staffId: Uuid,
      type: z.enum(["conges", "maladie", "formation", "autre"]).default("conges"),
      startDate: IsoDay,
      endDate: IsoDay,
    })
    .strict()
    .refine((body) => body.endDate >= body.startDate, { message: "endDate before startDate" })
    // Amplitude bornée : une absence > 1 an est une erreur de saisie.
    .refine(
      (body) => Date.parse(body.endDate) - Date.parse(body.startDate) <= 366 * 86_400_000,
      { message: "absence longer than a year" },
    );

  app.post("/rh/absences", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = AbsenceBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const created = await withTenant(request.tenantId, async (tx) => {
      const member = await tx.staffMember.findUnique({
        where: { id: parsed.data.staffId },
        select: { id: true },
      });
      if (!member) return null;
      return tx.staffAbsence.create({
        data: {
          tenantId: request.tenantId,
          staffId: parsed.data.staffId,
          type: parsed.data.type,
          startDate: new Date(`${parsed.data.startDate}T00:00:00Z`),
          endDate: new Date(`${parsed.data.endDate}T00:00:00Z`),
        },
        select: { id: true },
      });
    });
    if (!created) return reply.code(404).send({ error: "unknown staff member" });
    return reply.code(201).send(created);
  });

  app.delete("/rh/absences/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const deleted = await withTenant(request.tenantId, (tx) =>
      tx.staffAbsence.deleteMany({ where: { id: params.data.id } }),
    );
    if (deleted.count === 0) return reply.code(404).send({ error: "unknown absence" });
    return { deleted: true };
  });

  // Plan capacité vs charge : MÊME chemin que l'agent (outil owner-gated du
  // toolset lié au tenant) — une seule implémentation, deux consommateurs.
  app.get("/rh/plan", { preHandler: ownerRoute }, async (request, reply) => {
    const query = z
      .object({ hourlyRateEur: z.coerce.number().min(10).max(500).optional() })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("plan_staffing", {
        ...(query.data.hourlyRateEur !== undefined
          ? { hourlyRateEur: query.data.hourlyRateEur }
          : {}),
      });
      return JSON.parse(result) as unknown;
    } catch (error) {
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "staffing plan unavailable",
      );
      return reply.code(503).send({ error: "plan indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  return app;
}
