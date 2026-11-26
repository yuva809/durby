-- Manage links sent by email (R2.4): one token hash per email. Expand only: one new table; a rollback needs nothing.

-- CreateTable
CREATE TABLE "reservation_manage_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_manage_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_manage_tokens_token_hash_key" ON "reservation_manage_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "reservation_manage_tokens_tenant_id_reservation_id_idx" ON "reservation_manage_tokens"("tenant_id", "reservation_id");

-- AddForeignKey
ALTER TABLE "reservation_manage_tokens" ADD CONSTRAINT "reservation_manage_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_manage_tokens" ADD CONSTRAINT "reservation_manage_tokens_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Row-level security (ADR 0005).
ALTER TABLE "reservation_manage_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_manage_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reservation_manage_tokens"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
