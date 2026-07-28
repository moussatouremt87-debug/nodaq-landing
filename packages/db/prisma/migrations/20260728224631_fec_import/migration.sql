-- CreateTable
CREATE TABLE "fec_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_hash" TEXT NOT NULL,
    "file_name" TEXT,
    "entry_count" INTEGER NOT NULL,
    "customer_count" INTEGER NOT NULL,
    "invoice_count" INTEGER NOT NULL,
    "overdue_count" INTEGER NOT NULL,
    "overdue_cents" INTEGER NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fec_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fec_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "customer_ref" TEXT NOT NULL,
    "customer_name" TEXT,
    "number" TEXT NOT NULL,
    "issued_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "residual_cents" INTEGER NOT NULL,
    "settled" BOOLEAN NOT NULL,

    CONSTRAINT "fec_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fec_imports_tenant_id_idx" ON "fec_imports"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fec_imports_tenant_id_file_hash_key" ON "fec_imports"("tenant_id", "file_hash");

-- CreateIndex
CREATE INDEX "fec_invoices_tenant_id_idx" ON "fec_invoices"("tenant_id");

-- CreateIndex
CREATE INDEX "fec_invoices_tenant_id_settled_idx" ON "fec_invoices"("tenant_id", "settled");

-- AddForeignKey
ALTER TABLE "fec_imports" ADD CONSTRAINT "fec_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fec_invoices" ADD CONSTRAINT "fec_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fec_invoices" ADD CONSTRAINT "fec_invoices_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "fec_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
