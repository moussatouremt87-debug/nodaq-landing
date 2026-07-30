-- Silae sync idempotence (ticket 3.10): source-HRIS employee id on staff.
-- Nullable; Postgres unique index allows multiple NULLs (manual rows).
ALTER TABLE "staff_members" ADD COLUMN "external_ref" TEXT;

CREATE UNIQUE INDEX "staff_members_tenant_id_external_ref_key"
  ON "staff_members"("tenant_id", "external_ref");
