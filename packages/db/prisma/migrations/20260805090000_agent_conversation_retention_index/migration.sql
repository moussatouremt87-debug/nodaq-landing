-- Index de balayage de la rétention des transcriptions (art. 5.1.e).
--
-- Le passage quotidien exécute, par tenant et jusqu'à 250 fois,
-- `DELETE … WHERE id IN (SELECT id … WHERE updated_at < seuil
--  ORDER BY updated_at ASC LIMIT 200)`. Sans index, chaque page trie la table
-- entière — et c'est le job le moins surveillé du produit.
--
-- `(tenant_id, updated_at)` et pas `(updated_at)` seul : la RLS ajoute
-- toujours le prédicat de tenant, donc l'index composite sert la sélection ET
-- le tri en une seule passe.
CREATE INDEX "agent_conversations_tenant_id_updated_at_idx"
  ON "agent_conversations"("tenant_id", "updated_at");
