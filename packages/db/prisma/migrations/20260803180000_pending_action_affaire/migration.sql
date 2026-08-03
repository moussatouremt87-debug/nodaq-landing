-- F6 — la file de validation recentrée sur l'affaire.
--
-- Une action à valider dit désormais À QUEL CHANTIER elle se rapporte. Sans
-- ça, l'owner validait « Relance — Facture 2026-124 » sans savoir de quel
-- chantier il s'agissait, sur un produit dont l'affaire est le pivot.
--
-- NULLABLE, sans exception, comme tout rattachement d'affaire (CLAUDE.md,
-- règle de structure n°1) : une action de frais généraux n'a pas de chantier,
-- et c'est le cas majoritaire au démarrage. Rendre le lien obligatoire « pour
-- la propreté » casserait l'existant et ajouterait une saisie à un produit
-- dont la promesse est qu'on n'en fait aucune.
--
-- CE LIEN NE COMPTE PAS DANS LA MARGE. Une décision n'est pas un coût : seule
-- `affaire_imputations` porte de l'argent. Rattacher une relance à un chantier
-- ne doit jamais en bouger le résultat.
ALTER TABLE "pending_actions" ADD COLUMN "affaire_id" UUID;

CREATE INDEX "pending_actions_tenant_affaire_idx"
  ON "pending_actions" ("tenant_id", "affaire_id");

-- Clé étrangère COMPOSITE (tenant_id, affaire_id) — deuxième couche
-- d'isolation, et la leçon de 4.1 : la RLS ne contraint QUE `tenant_id`,
-- l'intégrité référentielle contourne la RLS par conception Postgres. Une FK
-- simple sur `affaire_id` laisserait une action du tenant A pointer une
-- affaire du tenant B : invisible en lecture, mais l'isolation ne tiendrait
-- plus que sur la couche applicative, là où le CLAUDE.md en exige DEUX.
--
-- ON DELETE SET NULL, jamais CASCADE : une affaire ne se supprime pas (statut
-- ARCHIVEE), mais si une suppression survenait, elle ne doit pas emporter des
-- décisions en attente. Perdre le rattachement est réparable ; perdre l'action
-- ne l'est pas.
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_tenant_affaire_fkey"
  FOREIGN KEY ("tenant_id", "affaire_id") REFERENCES "affaires"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;
