-- Remote printer commands (ADR 0032 §15): Owner/Admin ask a location's Android till to find printers or to print a
-- test page; the till claims the command, runs it and posts the result. Expand only: a new table that older
-- releases ignore.

-- CreateEnum
CREATE TYPE "pos_printer_command_kind" AS ENUM ('find_printers', 'test_print');

-- CreateEnum
CREATE TYPE "pos_printer_command_status" AS ENUM ('pending', 'claimed', 'done', 'failed');

-- CreateTable
CREATE TABLE "pos_printer_commands" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "kind" "pos_printer_command_kind" NOT NULL,
    "status" "pos_printer_command_status" NOT NULL DEFAULT 'pending',
    "requested_by_user_id" UUID NOT NULL,
    "claimed_by_user_id" UUID,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "claimed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "pos_printer_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_printer_commands_tenant_id_location_id_created_at_idx" ON "pos_printer_commands"("tenant_id", "location_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_printer_commands_tenant_id_id_key" ON "pos_printer_commands"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "pos_printer_commands" ADD CONSTRAINT "pos_printer_commands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_printer_commands" ADD CONSTRAINT "pos_printer_commands_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- A command lives 5 minutes; it is claimed and finished in order, each time stamped once.
ALTER TABLE "pos_printer_commands" ADD CONSTRAINT "pos_printer_commands_expiry_check"
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '5 minutes');
ALTER TABLE "pos_printer_commands" ADD CONSTRAINT "pos_printer_commands_lifecycle_check"
  CHECK (("status" = 'pending' AND "claimed_at" IS NULL AND "claimed_by_user_id" IS NULL AND "completed_at" IS NULL AND "result" IS NULL)
      OR ("status" = 'claimed' AND "claimed_at" IS NOT NULL AND "claimed_by_user_id" IS NOT NULL AND "completed_at" IS NULL AND "result" IS NULL)
      OR ("status" IN ('done', 'failed') AND "claimed_at" IS NOT NULL AND "claimed_by_user_id" IS NOT NULL
          AND "completed_at" IS NOT NULL AND "completed_at" >= "claimed_at" AND "result" IS NOT NULL));
-- The result holds addresses and answer codes only (checked by the api's schema); this caps its size.
ALTER TABLE "pos_printer_commands" ADD CONSTRAINT "pos_printer_commands_result_size_check"
  CHECK ("result" IS NULL OR pg_column_size("result") <= 16384);

-- Row-level security (ADR 0005). Commands are short-lived operational rows: their status changes, every change audited.
ALTER TABLE "pos_printer_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_printer_commands" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_printer_commands"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Never deleted by the app: expired and finished commands stay as the record of what ran (a location's own deletion
-- cascades as the owner).
REVOKE DELETE, TRUNCATE ON "pos_printer_commands" FROM durby_app;
