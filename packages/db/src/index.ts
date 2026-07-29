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
