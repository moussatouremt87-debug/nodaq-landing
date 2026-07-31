-- Per-vertical module activation (ticket 3.11): owner overrides on top of
-- the versioned catalog defaults. Nullable = pure vertical defaults.
ALTER TABLE "tenant_profiles" ADD COLUMN "module_overrides" JSONB;
