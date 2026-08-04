-- Effacement (art. 17) — tarir la SOURCE DE RECOPIE introduite par le bloc 2.
--
-- `POST /contrats/:id/occurrences` écrit `contrats.client_name` sur chaque
-- affaire générée. Effacer une fiche prospect anonymisait donc les affaires
-- existantes pendant que le contrat, lui, gardait le nom — et le réécrivait
-- sur une affaire neuve au clic suivant. Un effacement qui se défait tout seul
-- n'est pas un effacement, c'est un délai.
--
-- Le lien est EXPLICITE et nullable : on refuse de rapprocher un contrat d'une
-- fiche par correspondance de noms. Deux clients homonymes existent, et
-- effacer le contrat du mauvais détruirait silencieusement la donnée d'un
-- tiers — alors qu'un contrat non rattaché reste un problème VISIBLE, compté
-- et annoncé par la route d'effacement.

ALTER TABLE "contrats" ADD COLUMN "prospect_id" UUID;

CREATE INDEX "contrats_tenant_id_prospect_id_idx"
  ON "contrats"("tenant_id", "prospect_id");

-- Clé étrangère COMPOSITE : l'intégrité référentielle contourne la RLS, donc
-- sans (tenant_id, prospect_id) un contrat d'un tenant pourrait pointer la
-- fiche d'un AUTRE tenant.
--
-- LISTE DE COLONNES PostgreSQL 15+ (`ON DELETE SET NULL ("prospect_id")`) :
-- sans elle, `SET NULL` sur une FK composite annule TOUTES les colonnes
-- référençantes, `tenant_id` compris — qui est NOT NULL. Piège déjà payé
-- (`20260803190000_set_null_column_lists`), on ne le rejoue pas.
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_tenant_prospect_fkey"
  FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "prospects"("tenant_id", "id")
  ON DELETE SET NULL ("prospect_id") ON UPDATE CASCADE;
