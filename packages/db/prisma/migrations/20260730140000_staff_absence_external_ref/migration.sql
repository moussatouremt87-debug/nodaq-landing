-- Silae sync reconciliation (audit 3.10): source-HRIS absence id, so a
-- changed absence updates its row instead of piling up a duplicate.
ALTER TABLE "staff_absences" ADD COLUMN "external_ref" TEXT;

CREATE UNIQUE INDEX "staff_absences_tenant_id_external_ref_key"
  ON "staff_absences"("tenant_id", "external_ref");
