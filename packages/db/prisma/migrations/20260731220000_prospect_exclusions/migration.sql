-- ============================================================================
-- CreateTable: prospect_exclusions (ticket 2.12 — audit RGPD).
--
-- La fiche opposée était conservée AU MOTIF qu'elle empêchait de réimporter la
-- personne. Elle ne l'empêchait pas : l'opposition efface e-mail et téléphone,
-- donc la seule clé d'appariement réaliste, et la création ne consultait rien.
-- La même personne pouvait être resaisie le lendemain et repartir en tête des
-- relances — la garde annoncée n'existait pas.
--
-- Cette table EST la liste d'exclusion. Elle ne porte aucune coordonnée en
-- clair : uniquement un SHA-256 de la coordonnée normalisée, salé par le
-- tenant. Limite assumée et documentée : l'espace des adresses e-mail reste
-- énumérable — c'est un verrou anti-réimport, pas un secret.
-- ============================================================================

CREATE TABLE "prospect_exclusions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_exclusions_pkey" PRIMARY KEY ("id")
);

-- Un condensat SHA-256 hexadécimal : rien d'autre n'a de sens ici, et une
-- coordonnée en clair glissée par erreur serait rejetée par la base.
ALTER TABLE "prospect_exclusions"
  ADD CONSTRAINT "prospect_exclusions_contact_hash_check"
  CHECK ("contact_hash" ~ '^[0-9a-f]{64}$');

-- L'unicité (tenant, condensat) rend l'ajout idempotent : s'opposer deux fois
-- ne crée pas deux lignes.
CREATE UNIQUE INDEX "prospect_exclusions_tenant_id_contact_hash_key"
  ON "prospect_exclusions"("tenant_id", "contact_hash");

ALTER TABLE "prospect_exclusions"
  ADD CONSTRAINT "prospect_exclusions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS : même pattern que les autres tables métier (cf. `rls_notes`).
ALTER TABLE "prospect_exclusions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prospect_exclusions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "prospect_exclusions"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
