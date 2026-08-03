-- Ticket 4.1 — trois chiffres que le produit ne peut PAS dériver aujourd'hui,
-- et qu'il vaut donc mieux faire DÉCLARER que deviner.
--
--  * `deposits_cents` : acomptes encaissés. Aucune table de paiements n'existe ;
--    un acompte deviné à partir d'un virement entrant serait faux le jour où le
--    virement est autre chose.
--  * `estimated_material_cents` : coût matière PRÉVU au devis, seule référence
--    possible de l'écart budget. Sans lui, l'écart n'est pas nul : il n'existe pas.
--  * `hours_worked` : heures réellement passées. Il n'y a pas de lignes de temps
--    dans le produit (les plannings RH ne portent pas le temps passé). Nullable
--    = INCONNU, et le calcul rend alors une borne supérieure au lieu de compter
--    zéro heure de travail — ce qui gonflerait la marge.
--
-- Les trois sont NULLABLES : « non renseigné » et « zéro » sont deux réponses
-- différentes, et les confondre est exactement ce que ce ticket interdit.

ALTER TABLE "affaires" ADD COLUMN "deposits_cents" BIGINT;
ALTER TABLE "affaires" ADD COLUMN "estimated_material_cents" BIGINT;
ALTER TABLE "affaires" ADD COLUMN "hours_worked" INTEGER;

ALTER TABLE "affaires" ADD CONSTRAINT "affaires_deposits_check" CHECK (
  "deposits_cents" IS NULL OR "deposits_cents" >= 0
);
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_estimated_material_check" CHECK (
  "estimated_material_cents" IS NULL OR "estimated_material_cents" >= 0
);
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_hours_worked_check" CHECK (
  "hours_worked" IS NULL OR "hours_worked" >= 0
);
