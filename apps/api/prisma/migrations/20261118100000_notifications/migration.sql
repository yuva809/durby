-- Stored notifications and each person's choices (docs/platform/notifications.md, ADR 0047). Tenant data: RLS like any
-- other; a person sees only their own rows, which the service checks. Rows are marked read, never deleted by the app.
-- Expand only.

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL,
    "push" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("tenant_id","user_id","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_id_key" ON "notifications"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_id_idx" ON "notifications"("tenant_id", "user_id", "id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" ~ '^[a-z][a-z_]*$' AND char_length("kind") <= 40);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_entity_type_check"
  CHECK ("entity_type" ~ '^[a-z][a-z_]*$' AND char_length("entity_type") <= 40);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_params_check"
  CHECK (jsonb_typeof("params") = 'object' AND octet_length("params"::text) <= 2048);
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_kind_check"
  CHECK ("kind" ~ '^[a-z][a-z_]*$' AND char_length("kind") <= 40);

-- Kept: read, not deleted by the app.
REVOKE DELETE, TRUNCATE ON "notifications" FROM durby_app;

-- Row-level security (ADR 0005).
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_preferences"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
