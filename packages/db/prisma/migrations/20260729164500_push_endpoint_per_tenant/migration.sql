-- Unicité de l'endpoint PAR TENANT (2.17, audit) : un même appareil peut
-- servir plusieurs organisations (expert-comptable multi-tenants).
DROP INDEX "push_subscriptions_endpoint_key";

CREATE UNIQUE INDEX "push_subscriptions_tenant_id_endpoint_key"
  ON "push_subscriptions"("tenant_id", "endpoint");
