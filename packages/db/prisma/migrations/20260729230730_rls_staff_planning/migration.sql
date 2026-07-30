-- ============================================================================
-- Row-Level Security sur `staff_members` et `staff_absences` (ticket 3.5 —
-- plannings RH. `staff_members` est le référentiel des salariés,
-- `staff_absences` le registre de leurs absences).
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "staff_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_members" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "staff_members"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

ALTER TABLE "staff_absences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_absences" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "staff_absences"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
