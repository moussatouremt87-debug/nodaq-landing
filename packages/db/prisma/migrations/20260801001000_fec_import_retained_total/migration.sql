-- ============================================================================
-- AlterTable: fec_imports.retained_cents (ticket 2.20 — US-8, suite d'audit).
--
-- Le total des retenues de garantie EN COURS est le SOLDE du compte 4117, pas
-- la somme des retenues portées par les factures. Une libération se
-- comptabilise souvent sous sa propre pièce (« débit 512 / crédit 4117 ») :
-- elle n'est alors rattachable à aucune facture, et sommer les retenues par
-- facture annoncerait « X € de retenue en cours » sur des sommes DÉJÀ
-- ENCAISSÉES.
--
-- Le solde est donc calculé à l'import, par la dérivation, et conservé ici.
-- La colonne par facture (`fec_invoices.retained_cents`) reste ce qu'elle
-- dit : la retenue portée par CETTE pièce.
--
-- DEFAULT 0 : un import antérieur n'avait pas ce calcul. Zéro est la valeur
-- honnête (rien de connu), et le prochain import recalcule tout.
-- ============================================================================

ALTER TABLE "fec_imports"
  ADD COLUMN "retained_cents" BIGINT NOT NULL DEFAULT 0;

-- Solde planché à zéro par tiers dans la dérivation : un négatif en base
-- signalerait un défaut de calcul, pas une donnée à interpréter.
ALTER TABLE "fec_imports"
  ADD CONSTRAINT "fec_imports_retained_cents_check" CHECK ("retained_cents" >= 0);
