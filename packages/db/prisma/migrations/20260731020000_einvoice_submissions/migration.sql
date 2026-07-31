-- CreateTable
CREATE TABLE "einvoice_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'emission',
    "status" TEXT NOT NULL DEFAULT 'prete',
    "pdp_reference" TEXT,
    "document_hash" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status_history" JSONB NOT NULL DEFAULT '[]',
    "last_error" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_submissions_tenant_id_invoice_number_direction_key" ON "einvoice_submissions"("tenant_id", "invoice_number", "direction");

-- CreateIndex
CREATE INDEX "einvoice_submissions_tenant_id_status_idx" ON "einvoice_submissions"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur (comme webhook_events_status_check /
-- customer_reviews_source_check) : une valeur hors du schéma applicatif serait
-- silencieusement exclue du plan par le safeParse applicatif.
ALTER TABLE "einvoice_submissions"
  ADD CONSTRAINT "einvoice_submissions_direction_check"
  CHECK ("direction" IN ('emission', 'ereporting'));

ALTER TABLE "einvoice_submissions"
  ADD CONSTRAINT "einvoice_submissions_status_check"
  CHECK ("status" IN ('prete', 'deposee', 'recue', 'prise_en_charge', 'approuvee', 'approuvee_partiellement', 'refusee', 'rejetee', 'encaissee', 'erreur'));
