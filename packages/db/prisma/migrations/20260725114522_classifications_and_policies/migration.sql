-- CreateTable
CREATE TABLE "classifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "frontier_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classifications_tenant_id_idx" ON "classifications"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_policies_tenant_id_key" ON "tenant_policies"("tenant_id");

-- AddForeignKey
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_policies" ADD CONSTRAINT "tenant_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security sur `classifications` et `tenant_policies`.
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- 1) RLS sur `classifications`.
--    FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "classifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "classifications" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "classifications"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

-- 2) RLS sur `tenant_policies`.
ALTER TABLE "tenant_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_policies" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tenant_policies"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
