-- RLS des trois tables du ticket 4.1. Règle n°6 du CLAUDE.md : toute table
-- métier ⇒ tenant_id + policy + test d'isolation qui échoue sans la policy.
--
-- `affaire_counters` en fait partie : sa seule fuite possible serait le NOMBRE
-- d'affaires d'un concurrent, mais un compteur non isolé se ferait aussi
-- INCRÉMENTER par un autre tenant — un chantier voisin décalerait vos
-- références.

ALTER TABLE "affaires" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "affaires" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "affaires"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

ALTER TABLE "affaire_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "affaire_counters" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "affaire_counters"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

ALTER TABLE "affaire_imputations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "affaire_imputations" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "affaire_imputations"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
