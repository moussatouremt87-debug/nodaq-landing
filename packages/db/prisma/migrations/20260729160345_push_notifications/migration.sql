-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "actions_enabled" BOOLEAN NOT NULL DEFAULT true,
    "alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_dispatch_states" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "push_dispatch_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_tenant_id_user_id_idx" ON "push_subscriptions"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_dispatch_states_tenant_id_user_id_category_key" ON "push_dispatch_states"("tenant_id", "user_id", "category");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_dispatch_states" ADD CONSTRAINT "push_dispatch_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
