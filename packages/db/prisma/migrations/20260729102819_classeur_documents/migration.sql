-- CreateTable
CREATE TABLE "classeur_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "photo" BYTEA NOT NULL,
    "doc_type" TEXT NOT NULL DEFAULT 'autre',
    "status" TEXT NOT NULL DEFAULT 'a_verifier',
    "extraction" JSONB,
    "original_extraction" JSONB,
    "corrections" JSONB NOT NULL DEFAULT '[]',
    "matched_transaction_id" TEXT,
    "matched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classeur_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classeur_documents_tenant_id_status_idx" ON "classeur_documents"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "classeur_documents_tenant_id_sha256_key" ON "classeur_documents"("tenant_id", "sha256");

-- AddForeignKey
ALTER TABLE "classeur_documents" ADD CONSTRAINT "classeur_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
