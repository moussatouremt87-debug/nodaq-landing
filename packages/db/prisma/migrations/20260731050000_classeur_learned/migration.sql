-- ============================================================================
-- Boucle d'apprentissage du classeur (ticket 2.16b).
--
-- `learned` journalise ce que la MÉMOIRE FOURNISSEUR a appliqué au moment du
-- classement : champ comblé ou désaccord signalé, avec le nombre de
-- corrections humaines qui le fondent. C'est une trace d'EXPLICABILITÉ — sans
-- elle, l'utilisateur verrait des champs pré-remplis sans savoir pourquoi.
--
-- La mémoire elle-même n'est PAS stockée : elle est dérivée des corrections
-- déjà en base à chaque classement (doctrine 2.9 — ce qui est dérivable n'est
-- pas conservé comme vérité).
--
-- Colonne sur une table métier EXISTANTE : `classeur_documents` porte déjà sa
-- policy RLS (`rls_classeur_documents`), aucune policy à ajouter.
-- ============================================================================

ALTER TABLE "classeur_documents" ADD COLUMN "learned" JSONB;
