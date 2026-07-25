-- pgvector is already active on `appdb` (ops/db/init, gotcha in CLAUDE.md) — this
-- statement is a no-op there. It IS required for `prisma migrate dev`'s shadow
-- database though: that database is reset from scratch on every run and only
-- replays THIS migration history (ops/db/init never runs against it), so without
-- this line the shadow DB wouldn't know the `vector` type used by
-- `document_chunks.embedding` below. IF NOT EXISTS keeps it idempotent everywhere.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "object_key" TEXT,
    "dept" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "hash" TEXT NOT NULL,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "dept" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_tenant_id_idx" ON "documents"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_hash_key" ON "documents"("tenant_id", "hash");

-- CreateIndex
CREATE INDEX "document_chunks_tenant_id_idx" ON "document_chunks"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_chunk_index_key" ON "document_chunks"("document_id", "chunk_index");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (HNSW vector index for cosine similarity search — pgvector 0.6.0 already
-- active, no CREATE EXTENSION here; see the gotcha in CLAUDE.md).
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- ============================================================================
-- Row-Level Security sur `documents` et `document_chunks`.
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "documents"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_chunks" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "document_chunks"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
