-- Ticket 2.18 — schéma OPS (support back-office).
-- Exception ASSUMÉE à la RLS métier (documentée CLAUDE.md) : tables non
-- tenant-scopées, accès réservé aux routes OPERATOR de l'API. Le rôle
-- runtime app_user y accède ; JAMAIS un corps d'e-mail brut ici.
CREATE SCHEMA IF NOT EXISTS "ops";

GRANT USAGE ON SCHEMA "ops" TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA "ops"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

CREATE TABLE "ops"."support_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "tenant_id" UUID,
    "user_id" UUID,
    "origin" TEXT,
    "level" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOUVEAU',
    "object_keys" JSONB NOT NULL DEFAULT '[]',
    "auth_signal" TEXT,
    "draft_reply" TEXT,
    "agent_report" JSONB,
    "in_reply_to" TEXT,
    "replied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "support_tickets_message_id_key" ON "ops"."support_tickets"("message_id");
CREATE INDEX "support_tickets_status_idx" ON "ops"."support_tickets"("status");
CREATE INDEX "support_tickets_created_at_idx" ON "ops"."support_tickets"("created_at");

CREATE TABLE "ops"."support_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "symptoms" TEXT NOT NULL,
    "cause" TEXT NOT NULL DEFAULT '',
    "resolution" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_issues_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_issues_validated_idx" ON "ops"."support_issues"("validated");

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "ops" TO app_user;
