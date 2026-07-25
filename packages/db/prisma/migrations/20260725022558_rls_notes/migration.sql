-- ============================================================================
-- Row-Level Security sur `notes` + rôle applicatif non-superuser.
--
-- PIÈGE À CONNAÎTRE : un superuser (ou un rôle BYPASSRLS) ignore la RLS.
-- L'application doit donc tourner avec `app_user`, jamais avec `postgres`.
-- Les migrations, elles, tournent en admin (DATABASE_URL).
--
-- PATTERN pour toute future table métier <t> :
--   1. `tenant_id uuid` non nullable + index (fait dans la migration Prisma).
--   2. ALTER TABLE <t> ENABLE ROW LEVEL SECURITY; ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
--   3. CREATE POLICY tenant_isolation ON <t> ... (copier le bloc `notes` ci-dessous).
--   4. Un test d'isolation dans packages/db/test/ (obligatoire, cf. CLAUDE.md).
-- ============================================================================

-- 1) Rôle applicatif (idempotent — les rôles sont globaux au cluster).
--    Mot de passe DE DEV : en staging/prod il est immédiatement écrasé via
--    `ALTER ROLE app_user PASSWORD ...` depuis le Secret Manager (ticket 0.3).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- 2) Droits minimaux du rôle applicatif (pas de DDL, pas de TRUNCATE).
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- 3) RLS sur la table métier `notes`.
--    FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;

-- 4) Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
--    correspond au contexte posé par withTenant() via
--    `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
--    `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
--    (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "notes"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
