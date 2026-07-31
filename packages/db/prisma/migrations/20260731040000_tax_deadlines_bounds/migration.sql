-- ============================================================================
-- Bornes de défense en profondeur sur `tax_deadlines` (ticket 2.9, audit RGPD).
--
-- La migration initiale posait un CHECK sur `status` mais laissait
-- `amount_cents` et `note` libres. Un montant NÉGATIF écrit hors du chemin API
-- DIMINUERAIT le total à décaisser affiché au dirigeant (le moteur additionne
-- les surcharges humaines sans borne) : un montant fantôme, exactement ce que
-- le ticket refuse. Les bornes SQL doublent donc celles de Zod, comme partout
-- ailleurs dans le schéma.
--
-- Migration séparée plutôt qu'édition de la précédente : réécrire une
-- migration déjà appliquée casserait sa somme de contrôle Prisma.
-- ============================================================================

ALTER TABLE "tax_deadlines"
  ADD CONSTRAINT "tax_deadlines_amount_cents_check"
  CHECK ("amount_cents" IS NULL OR ("amount_cents" >= 0 AND "amount_cents" <= 10000000000));

ALTER TABLE "tax_deadlines"
  ADD CONSTRAINT "tax_deadlines_note_length_check"
  CHECK ("note" IS NULL OR length("note") <= 500);
