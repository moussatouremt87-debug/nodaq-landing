-- Ticket 4.1 — l'objet Affaire, pivot du produit (ADR-007).
--
-- Trois tables : `affaires`, son compteur de référence `affaire_counters`, et
-- `affaire_imputations` (rattachement polymorphe, append-only).
--
-- Deux colonnes NULLABLES ajoutées à l'existant (`classeur_documents`,
-- `fec_invoices`) : aucun backfill, aucune contrainte NOT NULL. L'existant doit
-- continuer de fonctionner sans jamais connaître les affaires.

CREATE TABLE "affaires" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"              UUID NOT NULL,
  "reference"              TEXT NOT NULL,
  "label"                  TEXT NOT NULL,
  "client_name"            TEXT,
  "prospect_id"            UUID,
  "status"                 TEXT NOT NULL DEFAULT 'PROSPECT',
  "address"                TEXT,
  "latitude"               DOUBLE PRECISION,
  "longitude"              DOUBLE PRECISION,
  "quoted_amount_cents"    BIGINT,
  "vat_rate_bps"           INTEGER,
  "estimated_hours"        INTEGER,
  "retention_rate_bps"     INTEGER,
  "retention_release_date" DATE,
  "start_date"             DATE,
  "planned_end_date"       DATE,
  "actual_end_date"        DATE,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affaires_pkey" PRIMARY KEY ("id")
);

-- Défense en profondeur : l'app valide déjà par Zod, la base refuse le reste.
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_status_check" CHECK (
  "status" IN ('PROSPECT','DEVIS_ENVOYE','ACCEPTEE','EN_COURS','TERMINEE','PERDUE','ARCHIVEE')
);
-- Un taux négatif ou > 100 % n'est pas une donnée, c'est un bug qui se propage
-- ensuite dans un chiffre affiché au patron.
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_vat_rate_check" CHECK (
  "vat_rate_bps" IS NULL OR ("vat_rate_bps" >= 0 AND "vat_rate_bps" <= 10000)
);
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_retention_rate_check" CHECK (
  "retention_rate_bps" IS NULL OR ("retention_rate_bps" >= 0 AND "retention_rate_bps" <= 10000)
);
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_quoted_amount_check" CHECK (
  "quoted_amount_cents" IS NULL OR "quoted_amount_cents" >= 0
);
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_estimated_hours_check" CHECK (
  "estimated_hours" IS NULL OR "estimated_hours" >= 0
);

CREATE UNIQUE INDEX "affaires_tenant_id_reference_key" ON "affaires"("tenant_id", "reference");
CREATE INDEX "affaires_tenant_id_status_idx" ON "affaires"("tenant_id", "status");
CREATE INDEX "affaires_tenant_id_prospect_id_idx" ON "affaires"("tenant_id", "prospect_id");

ALTER TABLE "affaires" ADD CONSTRAINT "affaires_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, pas CASCADE : effacer une fiche de prospection (opposition RGPD)
-- ne doit pas emporter le chantier, qui a sa propre base légale.
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_prospect_id_fkey"
  FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Compteur de référence par tenant et par année. L'incrément se fait en UN
-- seul ordre (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) : le verrou de
-- ligne sérialise les créations simultanées. `count() + 1` produirait deux
-- fois « 2026-014 » sous concurrence.
CREATE TABLE "affaire_counters" (
  "tenant_id"  UUID NOT NULL,
  "year"       INTEGER NOT NULL,
  "next_seq"   INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affaire_counters_pkey" PRIMARY KEY ("tenant_id", "year")
);

ALTER TABLE "affaire_counters" ADD CONSTRAINT "affaire_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "affaire_imputations" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID NOT NULL,
  "affaire_id"   UUID NOT NULL,
  "target_type"  TEXT NOT NULL,
  "target_id"    TEXT NOT NULL,
  "source"       TEXT NOT NULL DEFAULT 'MANUELLE',
  "amount_cents" BIGINT,
  "amount_basis" TEXT,
  "subcontract"  BOOLEAN NOT NULL DEFAULT FALSE,
  "created_by"   TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at"   TIMESTAMP(3),
  "revoked_by"   TEXT,
  CONSTRAINT "affaire_imputations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_target_type_check" CHECK (
  "target_type" IN ('classeur_document','transaction_bancaire','facture','charge')
);
ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_source_check" CHECK (
  "source" IN ('AUTO','CONFIRMEE','MANUELLE')
);
-- Une base de montant absente est permise ; une base inventée ne l'est pas.
ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_amount_basis_check" CHECK (
  "amount_basis" IS NULL OR "amount_basis" IN ('ht','ttc')
);
-- Un montant sans base serait un chiffre dont on ne sait pas ce qu'il mesure :
-- il finirait additionné à tort dans un coût.
ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_amount_pair_check" CHECK (
  ("amount_cents" IS NULL) = ("amount_basis" IS NULL)
);

-- UNE SEULE imputation ACTIVE par pièce : une dépense ne peut pas être comptée
-- dans deux chantiers à la fois (elle serait facturée deux fois en marge).
-- Index partiel : les imputations révoquées, elles, s'accumulent — c'est la trace.
CREATE UNIQUE INDEX "affaire_imputations_active_target_key"
  ON "affaire_imputations"("tenant_id", "target_type", "target_id")
  WHERE "revoked_at" IS NULL;
CREATE INDEX "affaire_imputations_tenant_affaire_idx"
  ON "affaire_imputations"("tenant_id", "affaire_id", "revoked_at");
CREATE INDEX "affaire_imputations_tenant_target_idx"
  ON "affaire_imputations"("tenant_id", "target_type", "target_id");

ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_affaire_id_fkey"
  FOREIGN KEY ("affaire_id") REFERENCES "affaires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rattachements NULLABLES sur l'existant. Pas de DEFAULT, pas de backfill :
-- une pièce sans affaire reste parfaitement fonctionnelle.
ALTER TABLE "classeur_documents" ADD COLUMN "affaire_id" UUID;
ALTER TABLE "classeur_documents" ADD CONSTRAINT "classeur_documents_affaire_id_fkey"
  FOREIGN KEY ("affaire_id") REFERENCES "affaires"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "classeur_documents_tenant_id_affaire_id_idx"
  ON "classeur_documents"("tenant_id", "affaire_id");

ALTER TABLE "fec_invoices" ADD COLUMN "affaire_id" UUID;
ALTER TABLE "fec_invoices" ADD CONSTRAINT "fec_invoices_affaire_id_fkey"
  FOREIGN KEY ("affaire_id") REFERENCES "affaires"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Coût horaire chargé (centimes). NULL par défaut : jamais deviné.
ALTER TABLE "tenant_profiles" ADD COLUMN "hourly_cost_cents" INTEGER;
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_hourly_cost_check" CHECK (
  "hourly_cost_cents" IS NULL OR "hourly_cost_cents" >= 0
);
