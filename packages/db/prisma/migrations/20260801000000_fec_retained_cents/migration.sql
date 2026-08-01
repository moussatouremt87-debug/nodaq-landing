-- ============================================================================
-- AlterTable: fec_invoices.retained_cents (ticket 2.20 — US-8, retenue de
-- garantie).
--
-- Dans le bâtiment, le client retient contractuellement 5 % jusqu'à la levée
-- des réserves. Ce n'est PAS un impayé : c'est une somme non encore exigible.
-- Comptablement elle vit au 4117 (« Clients — Retenues de garantie »), une
-- SUBDIVISION de 411 — que la dérivation des créances embarquait donc avec les
-- créances ordinaires, jusqu'à préparer une relance dessus.
--
-- DEFAULT 0 : les lignes déjà importées n'ont pas de retenue connue. Zéro est
-- ici la vérité (aucune retenue détectée), pas une valeur de remplissage —
-- le prochain import recalcule tout depuis le fichier.
-- ============================================================================

ALTER TABLE "fec_invoices"
  ADD COLUMN "retained_cents" BIGINT NOT NULL DEFAULT 0;

-- Une retenue est un montant positif ou nul : un négatif signalerait une
-- libération sur-comptabilisée, qui doit être vue et non absorbée en silence.
ALTER TABLE "fec_invoices"
  ADD CONSTRAINT "fec_invoices_retained_cents_check" CHECK ("retained_cents" >= 0);
