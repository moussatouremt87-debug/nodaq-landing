import { PrismaClient } from "@prisma/client";
import { DATABASE_URL } from "./env.js";

/**
 * Client ADMIN (rôle `postgres`, superuser → RLS non appliquée).
 * Réservé aux seeds, aux tests et à l'outillage. NE JAMAIS l'utiliser dans du
 * code de requête applicatif : il voit tous les tenants.
 */
export function createAdminClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  });
}
