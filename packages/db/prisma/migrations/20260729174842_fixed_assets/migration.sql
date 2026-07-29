-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "in_service_date" TIMESTAMP(3) NOT NULL,
    "base_cents" BIGINT NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'LINEAIRE',
    "source" TEXT NOT NULL DEFAULT 'MANUEL',
    "source_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIF',
    "disposed_at" TIMESTAMP(3),
    "prior_depreciation_cents" BIGINT NOT NULL DEFAULT 0,
    "renewal_cost_cents" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fixed_assets_tenant_id_status_idx" ON "fixed_assets"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
