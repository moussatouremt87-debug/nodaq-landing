-- ============================================================================
-- CreateTable: prospects + prospect_interactions (ticket 2.12 — CRM &
-- prospection).
--
-- PREMIÈRES tables du produit qui portent les données de personnes qui ne sont
-- PAS clientes. Deux colonnes ne relèvent pas du confort produit mais de
-- l'obligation :
--   * `source` NOT NULL : provenance déclarée (art. 14 — pouvoir dire d'où
--     vient une donnée non collectée auprès de la personne) ;
--   * `opted_out` : opposition (art. 21), exclusion structurelle des relances.
--
-- Le « dernier contact » n'est PAS une colonne : il est dérivé du journal
-- append-only `prospect_interactions` (doctrine 2.9/2.16b).
-- ============================================================================

CREATE TABLE "prospects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'nouveau',
    "source" TEXT NOT NULL,
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "opted_out_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);

-- Défense en profondeur : une étape ou une provenance hors du schéma
-- applicatif rendrait les seuils de relance inapplicables et la fiche
-- ininterprétable. `achat_fichier` est volontairement ABSENT — sa licéité se
-- juge fichier par fichier, le produit ne la légitime pas par une case.
ALTER TABLE "prospects"
  ADD CONSTRAINT "prospects_stage_check"
  CHECK ("stage" IN ('nouveau', 'contacte', 'qualifie', 'devis_envoye', 'gagne', 'perdu'));

ALTER TABLE "prospects"
  ADD CONSTRAINT "prospects_source_check"
  CHECK ("source" IN ('demande_entrante', 'recommandation', 'salon', 'reseau_pro', 'site_web', 'saisie_manuelle'));

-- Bornes de taille : une note de 10 Mo n'est pas une note, et un nom de
-- 100 000 caractères sert à autre chose qu'à nommer quelqu'un.
ALTER TABLE "prospects"
  ADD CONSTRAINT "prospects_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 200);

ALTER TABLE "prospects"
  ADD CONSTRAINT "prospects_notes_length_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 1000);

-- Cohérence de l'opposition : une fiche opposée porte SA date. Sans elle, on
-- ne peut plus prouver depuis quand la personne s'est opposée.
ALTER TABLE "prospects"
  ADD CONSTRAINT "prospects_opted_out_at_check"
  CHECK (("opted_out" = false AND "opted_out_at" IS NULL) OR ("opted_out" = true AND "opted_out_at" IS NOT NULL));

CREATE INDEX "prospects_tenant_id_stage_idx" ON "prospects"("tenant_id", "stage");
CREATE INDEX "prospects_tenant_id_opted_out_idx" ON "prospects"("tenant_id", "opted_out");

ALTER TABLE "prospects"
  ADD CONSTRAINT "prospects_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Journal des contacts — APPEND-ONLY côté application : c'est la seule source
-- du « dernier contact », donc la seule chose qui décide qui est relancé.
CREATE TABLE "prospect_interactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_interactions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "prospect_interactions"
  ADD CONSTRAINT "prospect_interactions_kind_check"
  CHECK ("kind" IN ('appel', 'email', 'rdv', 'autre'));

ALTER TABLE "prospect_interactions"
  ADD CONSTRAINT "prospect_interactions_note_length_check"
  CHECK ("note" IS NULL OR char_length("note") <= 1000);

CREATE INDEX "prospect_interactions_tenant_id_prospect_id_occurred_at_idx"
  ON "prospect_interactions"("tenant_id", "prospect_id", "occurred_at");

ALTER TABLE "prospect_interactions"
  ADD CONSTRAINT "prospect_interactions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prospect_interactions"
  ADD CONSTRAINT "prospect_interactions_prospect_id_fkey"
  FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
