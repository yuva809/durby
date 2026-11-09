-- Expired print jobs (ADR 0033 §12): the worker's sweep stores a pending job past its maximum age as needs_check with
-- last_code print.expired, so the table says what the api shows. Such a job may never have been claimed, so the
-- lifecycle CHECK allows exactly that case without a claim. Expand only: the previous release never writes it and
-- reads it as needs check. Added NOT VALID, then validated (the pattern for CHECKs on filled tables); Prisma runs this
-- file as one transaction, so the DROP's exclusive lock still lasts until commit, which is short on this small table.

ALTER TABLE "pos_print_jobs" DROP CONSTRAINT "pos_print_jobs_lifecycle_check";
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_lifecycle_check"
  CHECK (("status" = 'pending' AND "claimed_at" IS NULL AND "claimed_by_user_id" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'claimed' AND "claimed_at" IS NOT NULL AND "claimed_by_user_id" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" IN ('printed', 'failed', 'needs_check') AND "claimed_at" IS NOT NULL
          AND "claimed_by_user_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "completed_at" >= "claimed_at")
      -- Expired while waiting: never claimed (or its claim cleared by a retry), stamped by the sweep.
      OR ("status" = 'needs_check' AND "last_code" = 'print.expired' AND "claimed_at" IS NULL
          AND "claimed_by_user_id" IS NULL AND "completed_at" IS NOT NULL)) NOT VALID;
ALTER TABLE "pos_print_jobs" VALIDATE CONSTRAINT "pos_print_jobs_lifecycle_check";
