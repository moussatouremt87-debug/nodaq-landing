-- ============================================================================
-- CreateTable: cost_entries (ticket 2.8 — marge).
--
-- Une marge se calcule sur ce qui est CONNU. Un poste sans ligne pour un mois
-- est un poste MANQUANT — le moteur ne produit alors qu'une BORNE SUPÉRIEURE,
-- jamais un chiffre. D'où l'absence de toute valeur par défaut : rien ici ne
-- doit pouvoir se lire comme « cette charge vaut zéro ».
--
-- `amount_cents` peut être NÉGATIF : sur un mois, les avoirs obtenus peuvent
-- dépasser les achats. Le ramener à zéro fabriquerait une charge qui n'existe
-- pas, et gonflerait la marge.
-- ============================================================================

CREATE TABLE "cost_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_entries_pkey" PRIMARY KEY ("id")
);

-- Défense en profondeur : un poste hors catalogue serait silencieusement
-- ignoré par le moteur, donc absent de la marge SANS être compté comme
-- manquant — le pire des deux mondes.
ALTER TABLE "cost_entries"
  ADD CONSTRAINT "cost_entries_category_check"
  CHECK ("category" IN ('achats', 'sous_traitance', 'main_oeuvre', 'services_exterieurs', 'impots_taxes', 'autres_charges'));

ALTER TABLE "cost_entries"
  ADD CONSTRAINT "cost_entries_source_check"
  CHECK ("source" IN ('fec', 'saisi'));

ALTER TABLE "cost_entries"
  ADD CONSTRAINT "cost_entries_month_check"
  CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Borne de magnitude (20 M€ par mois et par poste) : au-delà, c'est une faute
-- de frappe ou un fichier aberrant, et le montant écraserait la marge sans
-- qu'on le voie. La borne reste DANS la capacité d'un INTEGER : un CHECK plus
-- large que la colonne laisserait passer la validation puis échouerait à
-- l'écriture, ce qui ferait tomber tout l'import au lieu de rejeter la ligne.
ALTER TABLE "cost_entries"
  ADD CONSTRAINT "cost_entries_amount_check"
  CHECK ("amount_cents" BETWEEN -2000000000 AND 2000000000);

-- (tenant, mois, poste, SOURCE) : un import FEC rejoué met à jour SA ligne
-- sans écraser une saisie humaine du même poste — et inversement.
CREATE UNIQUE INDEX "cost_entries_tenant_id_month_category_source_key"
  ON "cost_entries"("tenant_id", "month", "category", "source");

CREATE INDEX "cost_entries_tenant_id_month_idx" ON "cost_entries"("tenant_id", "month");

ALTER TABLE "cost_entries"
  ADD CONSTRAINT "cost_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
