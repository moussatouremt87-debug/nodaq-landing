-- CreateTable
CREATE TABLE "processing_activities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "data_categories" JSONB NOT NULL,
    "data_subjects" JSONB NOT NULL,
    "recipients" TEXT,
    "retention" TEXT NOT NULL,
    "sensitive_data" BOOLEAN NOT NULL DEFAULT false,
    "source_template" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "processing_activities_tenant_id_name_key" ON "processing_activities"("tenant_id", "name");

-- AddForeignKey
ALTER TABLE "processing_activities" ADD CONSTRAINT "processing_activities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur (comme customer_reviews_source_check /
-- tenant_profiles_vertical_check) : une valeur hors du schéma applicatif serait
-- silencieusement exclue du plan par le safeParse applicatif.
ALTER TABLE "processing_activities"
  ADD CONSTRAINT "processing_activities_legal_basis_check"
  CHECK ("legal_basis" IN ('consentement', 'contrat', 'obligation_legale', 'interet_legitime', 'mission_publique', 'interets_vitaux'));
