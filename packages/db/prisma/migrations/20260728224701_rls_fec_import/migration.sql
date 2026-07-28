-- ============================================================================
-- Row-Level Security sur `fec_imports` et `fec_invoices` (ticket 2.14, import
-- FEC — données CONFIDENTIELLES : dérivées du journal comptable).
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "fec_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fec_imports" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "fec_imports"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "fec_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fec_invoices" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : idem, sur `fec_invoices` (chaque ligne rattache aussi une
-- facture à son import via import_id, mais l'isolation tenant reste posée sur
-- tenant_id, comme pour toute autre table métier).
CREATE POLICY tenant_isolation ON "fec_invoices"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
