-- Print jobs (ADR 0033 §10–12): what a location's tills print on its printers. A sent ticket queues one job per printer
-- that is on and serves its station, in the ticket's own transaction; a device without the app queues a bill for a
-- receipt printer. A till with the app claims a job with one atomic UPDATE, prints it and reports the result. Expand
-- only: a new table that older releases ignore.

-- CreateEnum
CREATE TYPE "pos_print_job_kind" AS ENUM ('ticket', 'bill');

-- CreateEnum
CREATE TYPE "pos_print_job_status" AS ENUM ('pending', 'claimed', 'printed', 'failed', 'needs_check');

-- CreateTable
CREATE TABLE "pos_print_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "printer_id" UUID NOT NULL,
    "kind" "pos_print_job_kind" NOT NULL,
    "order_id" UUID NOT NULL,
    "ticket_id" UUID,
    "status" "pos_print_job_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_code" TEXT,
    "not_before" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "claimed_by_user_id" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pos_print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_print_jobs_tenant_id_id_key" ON "pos_print_jobs"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "pos_print_jobs_tenant_id_order_id_idx" ON "pos_print_jobs"("tenant_id", "order_id");

-- AddForeignKey
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_tenant_id_printer_id_fkey" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "pos_printers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "pos_orders"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "pos_kitchen_tickets"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- A ticket job names its ticket; a bill job has none.
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_kind_check"
  CHECK (("kind" = 'ticket' AND "ticket_id" IS NOT NULL) OR ("kind" = 'bill' AND "ticket_id" IS NULL));
-- Pending: nobody holds it. Claimed: one till holds it. Finished (printed, failed, needs_check): stamped once. A retry
-- or a reprint puts it back to pending and clears the claim.
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_lifecycle_check"
  CHECK (("status" = 'pending' AND "claimed_at" IS NULL AND "claimed_by_user_id" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'claimed' AND "claimed_at" IS NOT NULL AND "claimed_by_user_id" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" IN ('printed', 'failed', 'needs_check') AND "claimed_at" IS NOT NULL
          AND "claimed_by_user_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "completed_at" >= "claimed_at"));
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_attempts_check" CHECK ("attempts" >= 0);
-- Never printed by itself after this instant (setting pos.printJobMaxAgeSeconds when queued; a reprint starts a new
-- window of the same length).
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_expiry_check" CHECK ("expires_at" > "created_at");
-- An answer code of the print object (print.*), nothing else.
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_last_code_check"
  CHECK ("last_code" IS NULL OR "last_code" ~ '^print\.[a-z_]{1,40}$');

-- Never two jobs for the same ticket on the same printer: a repeated send can't queue it twice.
CREATE UNIQUE INDEX "pos_print_jobs_ticket_printer_key" ON "pos_print_jobs"("tenant_id", "ticket_id", "printer_id")
  WHERE "kind" = 'ticket';
-- One open bill per order and printer: a second "Print bill" while one is pending or claimed gets the same job.
CREATE UNIQUE INDEX "pos_print_jobs_open_bill_key" ON "pos_print_jobs"("tenant_id", "order_id", "printer_id")
  WHERE "kind" = 'bill' AND "status" IN ('pending', 'claimed');
-- The till's poll: due pending jobs of its location, oldest first (expired ones filtered by expires_at).
CREATE INDEX "pos_print_jobs_due_idx" ON "pos_print_jobs"("tenant_id", "location_id", "not_before", "id")
  WHERE "status" = 'pending';
-- The warnings: jobs held, failed or waiting for a check, by location.
CREATE INDEX "pos_print_jobs_open_idx" ON "pos_print_jobs"("tenant_id", "location_id", "status")
  WHERE "status" IN ('claimed', 'failed', 'needs_check');

-- Row-level security (ADR 0005). Jobs are operational rows whose status changes, every change audited.
ALTER TABLE "pos_print_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_print_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_print_jobs"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Never deleted by the app: what was printed, and when, stays (a location's own deletion cascades as the owner).
REVOKE DELETE, TRUNCATE ON "pos_print_jobs" FROM durby_app;
