-- Rétention de la file de validation (art. 5.1.e) — index du chemin de lecture.
--
-- Le balayage pagine par curseur sur `(created_at, id)`, tenant par tenant, à
-- l'intérieur de `withTenant` (la RLS ajoute `tenant_id`). Aucun index existant
-- ne sert cet ordre : `(tenant_id)`, `(tenant_id, status)` et
-- `(tenant_id, affaire_id)` obligeaient chaque page à retrier tout
-- l'historique du tenant.
--
-- Conséquence sans l'index, et c'est elle qui justifie la migration : le coût
-- croît avec l'arriéré, donc les tenants qui ont le plus de propositions
-- oubliées sont les premiers à dépasser le délai de transaction — ceux qui ont
-- le plus besoin d'être balayés sont ceux qu'on balaierait le moins.
--
-- Pas de nouvelle table : aucune policy RLS ni test d'isolation attendus ici.
CREATE INDEX "pending_actions_tenant_id_created_at_id_idx"
  ON "public"."pending_actions" ("tenant_id", "created_at", "id");
