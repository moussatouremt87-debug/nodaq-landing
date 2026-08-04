-- Packs verticaux (ticket 4.2) — la cible du pivot rejoint les valeurs storables.
--
-- Le `CHECK` de `tenant_profiles.vertical` est une défense en profondeur : le
-- schéma applicatif (Zod, `z.enum(VERTICALS)`) valide déjà, mais une valeur
-- écrite par un chemin oublié serait silencieusement acceptée sans lui. Les
-- deux listes doivent donc rester synchrones — un test le vérifie, en lisant
-- la contrainte EFFECTIVE de la base et non un fichier de migration.
--
-- AUCUNE VALEUR N'EST RETIRÉE, et ce n'est pas de la prudence de façade :
--
-- 1. `tenant_profiles` porte des lignes avec ces valeurs. Retirer `retail` du
--    CHECK, c'est refuser la prochaine écriture de la fiche d'un tenant qui
--    existe — un 500 le jour où il touche à son effectif.
-- 2. `retail` et `negoce` portent l'obligation « information du consommateur
--    sur les prix » (Code de la consommation, art. L112-1) dans la veille
--    réglementaire. Les supprimer retirerait une obligation LÉGALE à un
--    commerçant par effet de bord d'une refonte de découpage commercial.
--
-- Aucune donnée n'est réécrite non plus : un tenant `industrie_btp` reste
-- `industrie_btp`. Le renommer d'office en `batiment` reclasserait un
-- industriel en entreprise de travaux sans que personne l'ait demandé — et
-- changerait les obligations qui lui sont affichées.
ALTER TABLE "public"."tenant_profiles"
  DROP CONSTRAINT IF EXISTS "tenant_profiles_vertical_check";

ALTER TABLE "public"."tenant_profiles"
  ADD CONSTRAINT "tenant_profiles_vertical_check"
  CHECK ("vertical" IN (
    -- Cible du pivot (ADR-007).
    'batiment',
    'paysage',
    'evenementiel',
    'maintenance',
    'services_projet',
    -- Ancienne segmentation (3.7) — conservée, voir ci-dessus.
    'industrie_btp',
    'services',
    'negoce',
    'retail',
    'autre'
  ));
