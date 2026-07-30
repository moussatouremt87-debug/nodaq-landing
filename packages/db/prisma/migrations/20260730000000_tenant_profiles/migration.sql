-- CreateTable
CREATE TABLE "tenant_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT 'autre',
    "headcount_override" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_profiles_tenant_id_key" ON "tenant_profiles"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur (comme staff_members_weekly_hours_check) : une ligne
-- hors bornes serait silencieusement exclue du plan par le safeParse applicatif.
ALTER TABLE "tenant_profiles"
  ADD CONSTRAINT "tenant_profiles_headcount_check"
  CHECK ("headcount_override" IS NULL OR ("headcount_override" >= 0 AND "headcount_override" <= 10000));

ALTER TABLE "tenant_profiles"
  ADD CONSTRAINT "tenant_profiles_vertical_check"
  CHECK ("vertical" IN ('industrie_btp', 'retail', 'negoce', 'services', 'autre'));
