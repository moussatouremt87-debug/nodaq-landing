-- CreateTable
CREATE TABLE "pending_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" UUID,
    "validated_by" UUID,
    "validated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_actions_tenant_id_idx" ON "pending_actions"("tenant_id");

-- CreateIndex
CREATE INDEX "pending_actions_tenant_id_status_idx" ON "pending_actions"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security sur `pending_actions`.
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "pending_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_actions" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "pending_actions"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
