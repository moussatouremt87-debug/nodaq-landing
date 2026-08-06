-- Aligne la policy de `outbox` sur le patron maison.
--
-- La version d'origine omettait `NULLIF(..., '')` et le `FOR ALL` explicite,
-- présents partout ailleurs (`rls_notes`, `pending_actions`). Sans le NULLIF,
-- un GUC `app.current_tenant_id` posé à chaîne vide lève une erreur de cast au
-- lieu d'échouer FERMÉ comme le reste du produit — un mode de défaillance
-- différent des quinze autres tables, sur la seule qui alimente un canal
-- diffusé en permanence.

DROP POLICY IF EXISTS "tenant_isolation" ON "outbox";

CREATE POLICY "tenant_isolation" ON "outbox"
  FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid);
