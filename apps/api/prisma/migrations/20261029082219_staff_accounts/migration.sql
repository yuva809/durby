-- Durby staff and the platform audit log (docs/platform/admin-portal.md, ADR 0017). Platform tables outside every
-- tenant: no tenant_id, no RLS. Only platform/staff reaches them (the platform client refuses the models).

-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('super_admin', 'onboarding', 'support');

-- CreateEnum
CREATE TYPE "staff_status" AS ENUM ('invited', 'active', 'deactivated');

-- CreateEnum
CREATE TYPE "staff_session_state" AS ENUM ('pending', 'active');

-- CreateTable
CREATE TABLE "staff_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "staff_role" NOT NULL,
    "status" "staff_status" NOT NULL DEFAULT 'invited',
    "totp_secret" TEXT,
    "totp_enrolled_at" TIMESTAMPTZ(6),
    "totp_last_step" BIGINT,
    "last_login_at" TIMESTAMPTZ(6),
    "deactivated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "staff_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "staff_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "state" "staff_session_state" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "authenticated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "actor_staff_id" UUID,
    "actor_system" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "organization_id" UUID,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_accounts_email_key" ON "staff_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tokens_token_hash_key" ON "staff_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "staff_tokens_staff_id_idx" ON "staff_tokens"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_sessions_token_hash_key" ON "staff_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "staff_sessions_staff_id_idx" ON "staff_sessions"("staff_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_organization_id_id_idx" ON "platform_audit_logs"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "staff_tokens" ADD CONSTRAINT "staff_tokens_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_accounts"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_accounts"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Same form as users.email: stored lower-case and trimmed.
ALTER TABLE "staff_accounts" ADD CONSTRAINT "staff_accounts_email_lower_check"
  CHECK ("email" = lower(btrim("email")));
-- Deactivated accounts carry the time; active ones have a password. 2FA is enforced per session (an active account
-- without it, after a reset, must enroll at its next login), and an enrolled account always has its secret.
ALTER TABLE "staff_accounts" ADD CONSTRAINT "staff_accounts_status_check" CHECK (
  ("status" = 'deactivated') = ("deactivated_at" IS NOT NULL) AND
  ("status" <> 'active' OR "password_hash" IS NOT NULL) AND
  ("totp_enrolled_at" IS NULL OR "totp_secret" IS NOT NULL)
);

ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actor_check"
  CHECK (("actor_staff_id" IS NULL) <> ("actor_system" IS NULL));
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_action_format_check"
  CHECK ("action" ~ '^[a-z]+(\.[a-z_]+){2,}$');
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_reason_check"
  CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 1000);
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_snapshot_check" CHECK (
  ("before" IS NULL OR jsonb_typeof("before") = 'object') AND
  ("after" IS NULL OR jsonb_typeof("after") = 'object')
);

-- Append-only, like audit_logs (ADR 0008 §6): the default privileges grant DML to durby_app; take back all but
-- SELECT and INSERT, and refuse UPDATE/DELETE/TRUNCATE per statement for everyone, the owner included.
REVOKE UPDATE, DELETE, TRUNCATE ON "platform_audit_logs" FROM durby_app;

CREATE FUNCTION platform_audit_logs_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER platform_audit_logs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "platform_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_logs_append_only();
