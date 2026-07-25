/**
 * URLs de connexion. Deux rôles distincts, c'est le cœur du modèle de sécurité :
 * - DATABASE_URL (admin `postgres`) : migrations et seeds UNIQUEMENT — superuser,
 *   donc la RLS ne s'applique pas à lui.
 * - APP_DATABASE_URL (`app_user`, non-superuser) : tout le runtime applicatif —
 *   la RLS s'applique, une requête sans contexte tenant ne voit AUCUNE ligne.
 * Les valeurs par défaut correspondent à la stack de dev `ops/` ; en prod elles
 * viennent du Secret Manager (ticket 0.3), jamais du code.
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/appdb";

export const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgresql://app_user:app_password@localhost:5432/appdb";
