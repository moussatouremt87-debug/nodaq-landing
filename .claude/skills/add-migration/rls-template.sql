-- RLS template for a new business table <TABLE>.
-- Copy into the migration that follows the Prisma schema migration,
-- replace <TABLE>, keep USING and WITH CHECK strictly identical.
-- Reference implementation: packages/db/prisma/migrations/*_rls_notes/migration.sql

-- The app role is subject to RLS (never run the app as superuser `postgres`);
-- FORCE also applies the policy to the table owner.
ALTER TABLE "<TABLE>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "<TABLE>" FORCE ROW LEVEL SECURITY;

-- A row is visible/writable only when its tenant_id matches the transaction-scoped
-- context set by withTenant() via set_config('app.current_tenant_id', <uuid>, true).
-- current_setting(..., TRUE) returns NULL when unset -> zero rows, no SQL error
-- (fail closed). NULLIF guards against an empty-string cast.
CREATE POLICY tenant_isolation ON "<TABLE>"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
