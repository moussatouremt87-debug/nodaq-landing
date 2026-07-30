-- CreateTable
CREATE TABLE "customer_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manuel',
    "external_id" TEXT,
    "author_name" TEXT,
    "rating" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL,
    "reply_text" TEXT,
    "replied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_reviews_tenant_id_source_external_id_key" ON "customer_reviews"("tenant_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "customer_reviews_tenant_id_reviewed_at_idx" ON "customer_reviews"("tenant_id", "reviewed_at");

-- AddForeignKey
ALTER TABLE "customer_reviews" ADD CONSTRAINT "customer_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur (comme staff_members_weekly_hours_check /
-- tenant_profiles_vertical_check) : une ligne hors bornes serait silencieusement
-- exclue du plan par le safeParse applicatif.
ALTER TABLE "customer_reviews"
  ADD CONSTRAINT "customer_reviews_rating_check"
  CHECK ("rating" BETWEEN 1 AND 5);

ALTER TABLE "customer_reviews"
  ADD CONSTRAINT "customer_reviews_source_check"
  CHECK ("source" IN ('manuel', 'google', 'autre'));
