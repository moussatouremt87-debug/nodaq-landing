-- Ticket 4.2 bloc 2 — contrats récurrents (entretien, maintenance, forfait
-- mensuel). Le mot vient du pack vertical, jamais du code.
--
-- `affaires.contrat_id` est NULLABLE, sans exception (règle de structure n°1,
-- CLAUDE.md) : la majorité des affaires ne viennent d'aucun contrat, et
-- l'existant doit continuer de fonctionner sans connaître les contrats.
--
-- La clé étrangère composite (tenant_id, contrat_id) utilise la LISTE DE
-- COLONNES PostgreSQL 15+ (`ON DELETE SET NULL ("contrat_id")`) — sans elle,
-- `SET NULL` sur une FK composite annule TOUTES les colonnes référençantes,
-- `tenant_id` compris, qui est NOT NULL partout par construction. Le piège a
-- déjà été payé une fois (voir `20260803190000_set_null_column_lists`) : on
-- ne le rejoue pas ici.

CREATE TABLE "contrats" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"             UUID NOT NULL,
  "label"                 TEXT NOT NULL,
  "client_name"           TEXT,
  "cadence"               TEXT NOT NULL,
  "amount_cents"          BIGINT,
  "vat_rate_bps"          INTEGER,
  "start_date"            DATE,
  "end_date"              DATE,
  "last_occurrence_date"  DATE,
  "status"                TEXT NOT NULL DEFAULT 'ACTIF',
  "notes"                 TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contrats_pkey" PRIMARY KEY ("id")
);

-- Défense en profondeur : l'app valide déjà par Zod, la base refuse le reste.
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_cadence_check" CHECK (
  "cadence" IN ('mensuel','trimestriel','semestriel','annuel')
);
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_status_check" CHECK (
  "status" IN ('ACTIF','SUSPENDU','TERMINE')
);
-- Un taux négatif ou > 100 % n'est pas une donnée, c'est un bug qui se
-- propage ensuite dans un chiffre affiché au patron.
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_vat_rate_check" CHECK (
  "vat_rate_bps" IS NULL OR ("vat_rate_bps" >= 0 AND "vat_rate_bps" <= 10000)
);
-- Un montant PAR PÉRIODE négatif fabriquerait un chiffre d'affaires récurrent
-- inventé.
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_amount_check" CHECK (
  "amount_cents" IS NULL OR "amount_cents" >= 0
);

-- Cible de la clé étrangère composite des affaires : l'intégrité
-- référentielle contourne la RLS, donc sans elle une affaire d'un tenant
-- pouvait pointer le contrat d'un AUTRE tenant.
CREATE UNIQUE INDEX "contrats_tenant_id_id_key" ON "contrats"("tenant_id", "id");
CREATE INDEX "contrats_tenant_id_status_idx" ON "contrats"("tenant_id", "status");

ALTER TABLE "contrats" ADD CONSTRAINT "contrats_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rattachement NULLABLE sur l'existant. Pas de DEFAULT, pas de backfill :
-- une affaire sans contrat reste parfaitement fonctionnelle (le cas
-- majoritaire).
ALTER TABLE "affaires" ADD COLUMN "contrat_id" UUID;

CREATE INDEX "affaires_tenant_id_contrat_id_idx"
  ON "affaires"("tenant_id", "contrat_id");

-- ON DELETE SET NULL, avec la LISTE DE COLONNES : seule "contrat_id" est mise
-- à NULL, jamais "tenant_id" (voir le commentaire d'en-tête).
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_tenant_contrat_fkey"
  FOREIGN KEY ("tenant_id", "contrat_id") REFERENCES "contrats"("tenant_id", "id")
  ON DELETE SET NULL ("contrat_id") ON UPDATE CASCADE;

-- RLS (règle n°6 du CLAUDE.md) : toute table métier ⇒ tenant_id + policy +
-- test d'isolation qui échoue sans la policy. Template bundlé :
-- .claude/skills/add-migration/rls-template.sql.

ALTER TABLE "contrats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contrats" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "contrats"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
