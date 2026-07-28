-- AlterTable
ALTER TABLE "fec_imports" ALTER COLUMN "overdue_cents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "fec_invoices" ALTER COLUMN "amount_cents" SET DATA TYPE BIGINT,
ALTER COLUMN "residual_cents" SET DATA TYPE BIGINT;
