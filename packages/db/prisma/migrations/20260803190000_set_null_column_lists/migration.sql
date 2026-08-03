-- `ON DELETE SET NULL` sur une clé COMPOSITE annule TOUTES les colonnes.
--
-- Le piège est silencieux et la revue l'a trouvé sur du code qui se disait
-- l'inverse. Sur une FK `(tenant_id, affaire_id)`, Postgres exécute :
--
--   UPDATE ONLY child SET tenant_id = NULL, affaire_id = NULL WHERE ...
--
-- Or `tenant_id` est NOT NULL partout, par construction (règle n°6). La
-- suppression d'une affaire ne DÉTACHAIT donc pas la ligne : elle levait un
-- 23502, c'est-à-dire un RESTRICT déguisé en erreur 500. Vérifié en base avant
-- d'écrire cette migration, pas supposé.
--
-- Conséquence concrète, et c'est elle qui rend la correction non négociable :
-- la cascade `tenants -> affaires` d'un effacement RGPD pouvait échouer selon
-- l'ordre choisi par Postgres. Un droit à l'effacement qui plante n'est pas un
-- refus motivé, c'est une obligation légale non tenue.
--
-- PostgreSQL 15 a introduit la liste de colonnes, qui dit exactement ce qu'on
-- voulait dire (l'image est `pgvector/pgvector:pg16`).
--
-- Les DEUX contraintes de ce type sont corrigées : celle de F6 sur les actions
-- à valider, et sa jumelle de 4.1 sur le prospect d'une affaire — écrite avec
-- le même défaut, et jamais déclenchée parce que rien ne supprime encore de
-- prospect. Laisser la seconde en connaissance de cause aurait été choisir le
-- moment où elle exploserait.

ALTER TABLE "pending_actions" DROP CONSTRAINT "pending_actions_tenant_affaire_fkey";
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_tenant_affaire_fkey"
  FOREIGN KEY ("tenant_id", "affaire_id") REFERENCES "affaires"("tenant_id", "id")
  ON DELETE SET NULL ("affaire_id") ON UPDATE CASCADE;

ALTER TABLE "affaires" DROP CONSTRAINT "affaires_tenant_prospect_fkey";
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_tenant_prospect_fkey"
  FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "prospects"("tenant_id", "id")
  ON DELETE SET NULL ("prospect_id") ON UPDATE CASCADE;
