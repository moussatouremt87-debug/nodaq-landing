-- ============================================================================
-- Row-Level Security sur `push_subscriptions` et `push_dispatch_states`
-- (ticket 2.17 — notifications push Web/PWA : abonnements par appareil et
-- état de regroupement anti-spam).
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation : une ligne n'est visible/modifiable que si son tenant_id
-- correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., true)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "push_subscriptions"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

ALTER TABLE "push_dispatch_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_dispatch_states" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "push_dispatch_states"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
