-- AlterTable
ALTER TABLE "pending_actions" ADD COLUMN     "employee" TEXT,
ADD COLUMN     "executed_at" TIMESTAMP(3),
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "agent_conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_conversations_tenant_id_idx" ON "agent_conversations"("tenant_id");

-- AddForeignKey
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security sur `agent_conversations`.
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici. `pending_actions` n'a pas de nouveau bloc RLS : ses nouvelles
-- colonnes (employee, executed_at, result) sont couvertes automatiquement par la
-- policy existante.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "agent_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_conversations" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "agent_conversations"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
