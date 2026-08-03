-- Ticket 4.1 — deux trous fermés en base, trouvés à la revue.
--
-- 1. MONTANT NÉGATIF (bloquant). `amount_cents` n'avait aucune contrainte de
--    signe : une imputation à −5 000 € faisait un coût matière négatif, donc
--    une marge SUPÉRIEURE au devis, rendue comme EXACTE. C'était atteignable en
--    un appel par le rôle le moins privilégié — très exactement le « chiffre
--    flatteur et faux » que ce ticket existe pour empêcher.
--    Un avoir se modélise en RÉVOQUANT une imputation, jamais par un coût
--    négatif : le signe n'a pas de sens ici.
ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_amount_sign_check" CHECK (
  "amount_cents" IS NULL OR "amount_cents" >= 0
);

-- 2. ISOLATION À DEUX COUCHES. La RLS ne contraint que `tenant_id` ; l'intégrité
--    référentielle, elle, contourne la RLS par conception Postgres. Une ligne
--    `affaire_imputations` du tenant A pouvait donc pointer une `affaire` du
--    tenant B : invisible en lecture, mais l'isolation ne tenait que sur la
--    couche applicative, alors que le CLAUDE.md en exige DEUX.
--    La clé étrangère composite rend le croisement impossible en base.
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_tenant_id_id_key" UNIQUE ("tenant_id", "id");
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_tenant_id_id_key" UNIQUE ("tenant_id", "id");

ALTER TABLE "affaire_imputations" DROP CONSTRAINT "affaire_imputations_affaire_id_fkey";
ALTER TABLE "affaire_imputations" ADD CONSTRAINT "affaire_imputations_tenant_affaire_fkey"
  FOREIGN KEY ("tenant_id", "affaire_id") REFERENCES "affaires"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "affaires" DROP CONSTRAINT "affaires_prospect_id_fkey";
ALTER TABLE "affaires" ADD CONSTRAINT "affaires_tenant_prospect_fkey"
  FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "prospects"("tenant_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;
