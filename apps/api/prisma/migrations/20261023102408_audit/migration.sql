-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('user', 'system');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_user_id" UUID,
    "actor_system" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_tenant_id_id_key" ON "audit_logs"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape checks (ADR 0008). Action keys are registered in packages/shared; SQL checks only the shape, open-ended
-- ({2,}) so longer keys in later phases need no constraint migration.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_check" CHECK (
  ("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "actor_system" IS NULL) OR
  ("actor_type" = 'system' AND "actor_user_id" IS NULL AND "actor_system" IS NOT NULL)
);
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_format_check"
  CHECK ("action" ~ '^[a-z]+(\.[a-z_]+){2,}$');
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_request_id_check"
  CHECK (char_length("request_id") <= 64);
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_snapshot_check" CHECK (
  ("before" IS NULL OR jsonb_typeof("before") = 'object') AND
  ("after" IS NULL OR jsonb_typeof("after") = 'object')
);

-- Row-level security (ADR 0005).
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only (ADR 0002 §4, ADR 0008 §6). The default privileges grant DML to durby_app; take back all but
-- SELECT and INSERT.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM durby_app;

-- Statement-level, so it also fires for UPDATE/DELETE matching zero rows and for TRUNCATE (row triggers don't),
-- and for the owner durby_migrator, which sees no rows under FORCE RLS without a tenant. The owner can still drop
-- or disable it; a catalog test fails if that happens (ADR 0008 §6). Trigger functions need no EXECUTE grant.
CREATE FUNCTION audit_logs_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
