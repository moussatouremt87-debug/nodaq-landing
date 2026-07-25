-- Audit completeness (RGPD review of ticket 1.1): blocked sovereignty attempts
-- and failed model calls must leave an audit row too, not only successes.
ALTER TABLE "classifications" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'allowed';
