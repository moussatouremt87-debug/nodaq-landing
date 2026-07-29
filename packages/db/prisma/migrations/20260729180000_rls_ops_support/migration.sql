-- Défense en profondeur du schéma ops (audit 2.18) : app_user est le MÊME
-- rôle que le code tenant/agent — sans rempart, un accès applicatif dévoyé
-- (ou une injection SQL) lirait tous les tickets support cross-tenant.
-- RLS gated sur app.ops_operator, posé UNIQUEMENT par withOps() (routes
-- /ops/* de l'API). Même pattern transactionnel que la RLS tenant.
ALTER TABLE "ops"."support_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops"."support_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_operator_only ON "ops"."support_tickets"
  USING (current_setting('app.ops_operator', true) = 'on')
  WITH CHECK (current_setting('app.ops_operator', true) = 'on');

ALTER TABLE "ops"."support_issues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops"."support_issues" FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_operator_only ON "ops"."support_issues"
  USING (current_setting('app.ops_operator', true) = 'on')
  WITH CHECK (current_setting('app.ops_operator', true) = 'on');
