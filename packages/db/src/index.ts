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
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  const id = TenantId.parse(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${id}, true)`;
    return fn(tx);
  });
}
