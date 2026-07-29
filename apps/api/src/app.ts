import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildToolset, ComptaAgent } from "@nodaq/agent-runtime";
import type { ToolsetContext } from "@nodaq/agent-runtime";
import { prisma, withTenant } from "@nodaq/db";
import type { Prisma } from "@nodaq/db";
import { deriveReceivables, parseFec } from "@nodaq/fec";
import {
  connectorSecretName,
  ConnectorNotConfiguredError,
  ConnectorType,
  FEC_CONNECTOR_STATUS,
  FEC_CONNECTOR_TYPE,
  getQontoClient,
  PennylaneClient,
  QontoClient,
} from "@nodaq/mcp-connectors";
import { defaultWritableProvider } from "@nodaq/secrets";
import type { WritableSecretProvider } from "@nodaq/secrets";
import { CreateNoteInput, TenantId, Uuid } from "@nodaq/shared";
import { auth } from "./auth.js";
import { DOC_TYPES, extractDocumentFields, matchTransactions } from "./classeur.js";
import type { DocExtraction } from "./classeur.js";
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
        return reply.code(201).send({
          alreadyImported: false,
          entryCount: parsed.entries.length,
          customerCount: derivation.customers.length,
          invoiceCount: derivation.invoices.length,
          overdueCount: derivation.overdueCount,
          overdueCents: derivation.overdueCents,
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
      { preHandler: businessRoute, bodyLimit: 8 * 1024 * 1024 },
      async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: "photo attendue (corps application/octet-stream)" });
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

    const updated = await withTenant(request.tenantId, async (tx) => {
      const document = await tx.classeurDocument.findUnique({
        where: { id },
        select: { extraction: true, corrections: true, docType: true },
      });
      if (!document) return null;
      const extraction = {
        ...(typeof document.extraction === "object" && document.extraction !== null
          ? document.extraction
          : {}),
        ...fields,
      };
      const corrections = [
        ...z.array(z.unknown()).catch([]).parse(document.corrections),
        { by: request.authSession.user.id, at: new Date().toISOString(), fields },
      ] as Prisma.InputJsonValue;
      return tx.classeurDocument.update({
        where: { id },
        data: {
          extraction,
          corrections,
          docType: fields.docType ?? document.docType,
          status: "verifie",
        },
        select: DOC_SELECT,
      });
    });
    if (!updated) return reply.code(404).send({ error: "not found" });
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

      let bank: QontoClient;
      try {
        bank = await getQontoClient(request.tenantId);
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

      const updated = await withTenant(request.tenantId, async (tx) => {
        const exists = await tx.classeurDocument.findUnique({ where: { id }, select: { id: true } });
        if (!exists) return null;
        return tx.classeurDocument.update({
          where: { id },
          data: transactionId
            ? { matchedTransactionId: transactionId, matchedAt: new Date(), status: "rapproche" }
            : { matchedTransactionId: null, matchedAt: null, status: "verifie" },
          select: DOC_SELECT,
        });
      });
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
