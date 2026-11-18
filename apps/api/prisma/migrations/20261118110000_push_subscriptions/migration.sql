-- Browsers that turned push on (docs/platform/notifications.md, ADR 0047). Tenant data: RLS like any other; a person
-- adds and removes only their own, which the service checks. The endpoint is a capability URL: never logged.
-- Expand only.

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_tenant_id_endpoint_key" ON "push_subscriptions"("tenant_id", "endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_tenant_id_user_id_idx" ON "push_subscriptions"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_endpoint_check"
  CHECK ("endpoint" ~ '^https://' AND char_length("endpoint") <= 1024);
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_keys_check"
  CHECK (char_length("p256dh") BETWEEN 80 AND 100 AND char_length("auth") BETWEEN 16 AND 32);

-- Row-level security (ADR 0005).
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "push_subscriptions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
