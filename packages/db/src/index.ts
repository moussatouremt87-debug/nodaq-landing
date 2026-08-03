import { PrismaClient, type Prisma } from "@prisma/client";
import { TenantId } from "@nodaq/shared";
import { APP_DATABASE_URL } from "./env.js";

export { Prisma } from "@prisma/client";
export type {
  Note,
  Tenant,
  User,
  Membership,
  Invitation,
  Session,
  Classification,
  TenantPolicy,
  Connector,
  Document,
  DocumentChunk,
  PendingAction,
  AgentConversation,
  FecImport,
  FecInvoice,
  WebhookEndpoint,
  WebhookEvent,
} from "@prisma/client";

/**
 * Client applicatif : connecté avec le rôle `app_user` (non-superuser), donc soumis
 * à la Row-Level Security. Hors `withTenant`, aucune ligne des tables scellées n'est
 * visible — c'est voulu.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: APP_DATABASE_URL } },
});

/** Client transactionnel scellé sur un tenant, passé au callback de `withTenant`. */
export type TenantClient = Prisma.TransactionClient;

/**
 * Exécute `fn` dans une transaction dont le contexte tenant est fixé pour la durée
 * de la transaction (`set_config(..., true)` = portée transaction, donc sûr malgré
 * le pooling de connexions Prisma). TOUTE requête applicative sur une table métier
 * passe par ce helper — jamais de `prisma.note.*` direct.
 */
export interface WithTenantOptions {
  /** Durée max de la transaction en ms (défaut Prisma : 5 000). Pour les
   * écritures en masse (ex. import FEC) qui dépasseraient le défaut. */
  timeoutMs?: number;
}

export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const id = TenantId.parse(tenantId);
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${id}, true)`;
      return fn(tx);
    },
    options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
  );
}

/**
 * Seule porte d'accès aux tables du schéma `ops` (support back-office, 2.18).
 * Défense en profondeur (audit 2.18) : les tables ops portent une RLS gated
 * sur `app.ops_operator` — posée ICI, dans la transaction, comme withTenant.
 * Un `prisma.supportTicket.*` lancé depuis du code tenant (ou une injection
 * SQL sous app_user) lit une table VIDE : l'exception « pas de RLS métier »
 * ne signifie pas « pas de rempart du tout ».
 */
export async function withOps<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.ops_operator', 'on', true)`;
    return fn(tx);
  });
}

/**
 * Resolution-only door for INBOUND webhook requests (ticket 2.13). A webhook
 * request arrives with no better-auth session and therefore no known tenant —
 * the endpoint (and thus its tenant) must be looked up BEFORE `withTenant` can
 * be opened at all. This helper poses the transaction-scoped
 * `app.webhook_resolver` flag that the `webhook_resolver_lookup` RLS policy
 * gates on, exactly like `withOps` poses `app.ops_operator`.
 *
 * Scope, strictly: read-only, limited to `webhook_endpoints`, and only exposes
 * endpoint metadata (id, tenantId, provider, secretRef, active) — never
 * business data. It must NEVER be used to read or write business tables; once
 * the endpoint (and its tenantId) is resolved, recording the actual webhook
 * event goes through the normal `withTenant(tenantId, …)` path so the event
 * row lands under the regular tenant RLS policy.
 */
export async function withWebhookResolver<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.webhook_resolver', 'on', true)`;
    return fn(tx);
  });
}

/** What the webhook route is allowed to learn before authenticating. */
export interface ResolvedWebhookEndpoint {
  id: string;
  tenantId: string;
  provider: string;
  secretRef: string;
}

/**
 * The ONLY intended use of the resolver gate: turn a (endpointId, provider)
 * pair from an unauthenticated request into its tenant. Deliberately narrow —
 * callers get one row or null, never a client they could use to enumerate
 * every tenant's endpoints. Inactive endpoints resolve to null (fail-closed).
 */
export async function resolveWebhookEndpoint(
  endpointId: string,
  provider: string,
): Promise<ResolvedWebhookEndpoint | null> {
  return withWebhookResolver((tx) =>
    tx.webhookEndpoint.findFirst({
      where: { id: endpointId, provider, active: true },
      select: { id: true, tenantId: true, provider: true, secretRef: true },
    }),
  );
}

export { nextAffaireReference } from "./affaireReference.js";
