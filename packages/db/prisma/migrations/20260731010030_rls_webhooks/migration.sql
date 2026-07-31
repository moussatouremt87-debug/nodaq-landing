-- ============================================================================
-- Row-Level Security sur `webhook_endpoints` / `webhook_events` (ticket 2.13 —
-- socle webhooks entrants).
--
-- PATTERN (cf. migration `rls_notes`) : le rôle applicatif `app_user` obtient ses
-- droits via les default privileges déjà posés dans `rls_notes` — pas de GRANT
-- superflu ici.
-- ============================================================================

-- FORCE = la RLS s'applique aussi au propriétaire de la table.
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;

-- Policy d'isolation classique : une ligne n'est visible/modifiable que si son
-- tenant_id correspond au contexte posé par withTenant() via
-- `set_config('app.current_tenant_id', <uuid>, true)` (portée transaction).
-- `current_setting(..., TRUE)` renvoie NULL si non posé -> aucune ligne visible
-- (échec fermé, sans erreur SQL). NULLIF protège du cast de chaîne vide.
CREATE POLICY tenant_isolation ON "webhook_events"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "webhook_endpoints"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);

-- Policy SUPPLÉMENTAIRE, en lecture seule et gated : une requête webhook
-- entrante n'a AUCUNE session applicative, donc aucun tenant connu — il faut
-- résoudre l'endpoint (et donc le tenant) AVANT de pouvoir ouvrir withTenant().
-- Cette porte est posée UNIQUEMENT par withWebhookResolver() (jamais par
-- withTenant), limitée à cette table, et n'expose que des métadonnées d'endpoint
-- (id, tenant_id, provider, secret_ref, active) — aucune donnée métier (les
-- événements webhook, eux, restent scellés derrière la policy tenant_isolation
-- ci-dessus). Même doctrine que la porte gated `app.ops_operator` (ticket 2.18).
CREATE POLICY webhook_resolver_lookup ON "webhook_endpoints"
  FOR SELECT
  USING (NULLIF(current_setting('app.webhook_resolver', TRUE), '') = 'on');
