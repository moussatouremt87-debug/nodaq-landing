-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_tenant_id_provider_key" ON "webhook_endpoints"("tenant_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_tenant_id_provider_external_id_key" ON "webhook_events"("tenant_id", "provider", "external_id");

-- CreateIndex
CREATE INDEX "webhook_events_tenant_id_status_idx" ON "webhook_events"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur (comme customer_reviews_source_check /
-- processing_activities_legal_basis_check) : une valeur hors du schéma
-- applicatif serait silencieusement exclue du plan par le safeParse applicatif.
ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_provider_check"
  CHECK ("provider" IN ('pdp', 'bridge', 'pennylane', 'qonto', 'test'));

ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_status_check"
  CHECK ("status" IN ('received', 'processed', 'ignored', 'failed'));
