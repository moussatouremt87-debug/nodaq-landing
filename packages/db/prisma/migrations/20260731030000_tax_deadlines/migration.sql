-- AlterTable: profil FISCAL du tenant (ticket 2.9 — pilote la génération de
-- l'échéancier fiscal & social, `taxCalendar.ts`). 'inconnu'/'aucune' PAR
-- DÉFAUT : le produit ne DEVINE JAMAIS le régime fiscal/social d'une
-- entreprise tant que l'owner ne l'a pas renseigné.
ALTER TABLE "tenant_profiles"
  ADD COLUMN "vat_regime" TEXT NOT NULL DEFAULT 'inconnu',
  ADD COLUMN "corporate_tax_liable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "fiscal_year_end_month" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN "payroll_periodicity" TEXT NOT NULL DEFAULT 'aucune';

-- Défense en profondeur (comme tenant_profiles_vertical_check) : une valeur
-- hors du schéma applicatif serait silencieusement exclue du plan par le
-- safeParse applicatif.
ALTER TABLE "tenant_profiles"
  ADD CONSTRAINT "tenant_profiles_vat_regime_check"
  CHECK ("vat_regime" IN ('inconnu', 'franchise', 'reel_simplifie', 'reel_normal_mensuel', 'reel_normal_trimestriel'));

ALTER TABLE "tenant_profiles"
  ADD CONSTRAINT "tenant_profiles_fiscal_year_end_month_check"
  CHECK ("fiscal_year_end_month" BETWEEN 1 AND 12);

ALTER TABLE "tenant_profiles"
  ADD CONSTRAINT "tenant_profiles_payroll_periodicity_check"
  CHECK ("payroll_periodicity" IN ('aucune', 'mensuelle', 'trimestrielle'));

-- CreateTable: tax_deadlines (ticket 2.9) — surcharges HUMAINES sur les
-- échéances DÉRIVÉES ; le calendrier lui-même est calculé, jamais stocké.
CREATE TABLE "tax_deadlines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "obligation_id" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "amount_cents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'prevu',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_deadlines_tenant_id_obligation_id_due_date_key" ON "tax_deadlines"("tenant_id", "obligation_id", "due_date");

-- CreateIndex
CREATE INDEX "tax_deadlines_tenant_id_due_date_idx" ON "tax_deadlines"("tenant_id", "due_date");

-- AddForeignKey
ALTER TABLE "tax_deadlines" ADD CONSTRAINT "tax_deadlines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur (comme einvoice_submissions_status_check) : une
-- valeur hors du schéma applicatif serait silencieusement exclue du plan par
-- le safeParse applicatif.
ALTER TABLE "tax_deadlines"
  ADD CONSTRAINT "tax_deadlines_status_check"
  CHECK ("status" IN ('prevu', 'paye', 'non_applicable'));
