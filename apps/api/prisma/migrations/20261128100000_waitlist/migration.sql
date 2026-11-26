-- Waitlist (ADR 0084). Expand only: one new table and three enums; a rollback needs nothing.

-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('waiting', 'notified', 'seated', 'left', 'removed');

-- CreateEnum
CREATE TYPE "waitlist_channel" AS ENUM ('email', 'in_person');

-- CreateEnum
CREATE TYPE "waitlist_notice_result" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "locale" TEXT NOT NULL,
    "party_size" INTEGER NOT NULL,
    "quoted_minutes" INTEGER,
    "status" "waitlist_status" NOT NULL DEFAULT 'waiting',
    "notified_at" TIMESTAMPTZ(6),
    "notice_channel" "waitlist_channel",
    "notice_result" "waitlist_notice_result",
    "emailed_at" TIMESTAMPTZ(6),
    "email_count" INTEGER NOT NULL DEFAULT 0,
    "ended_at" TIMESTAMPTZ(6),
    "erased_at" TIMESTAMPTZ(6),
    "reservation_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entries_tenant_id_location_id_status_created_at_idx" ON "waitlist_entries"("tenant_id", "location_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "waitlist_entries_tenant_id_location_id_ended_at_idx" ON "waitlist_entries"("tenant_id", "location_id", "ended_at");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_tenant_id_id_key" ON "waitlist_entries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_tenant_id_reservation_id_key" ON "waitlist_entries"("tenant_id", "reservation_id");

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_party_check"
  CHECK ("party_size" BETWEEN 1 AND 100 AND ("quoted_minutes" IS NULL OR "quoted_minutes" BETWEEN 0 AND 600));
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_contact_check"
  CHECK (("name" IS NULL OR char_length("name") BETWEEN 1 AND 100)
    AND ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$')
    AND ("email" IS NULL OR (char_length("email") BETWEEN 3 AND 254 AND "email" = lower("email") AND "email" LIKE '%_@_%'))
    AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200)
    AND "locale" ~ '^[a-z]{2}$');
-- Erased exactly when the name is gone; only an ended entry, and nothing else stays.
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_erased_check"
  CHECK (("erased_at" IS NULL) = ("name" IS NOT NULL)
    AND ("erased_at" IS NULL OR ("ended_at" IS NOT NULL AND "phone" IS NULL AND "email" IS NULL AND "note" IS NULL)));
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_status_check"
  CHECK (("status" IN ('seated', 'left', 'removed')) = ("ended_at" IS NOT NULL)
    AND ("status" = 'seated') = ("reservation_id" IS NOT NULL)
    AND ("status" <> 'notified' OR "notified_at" IS NOT NULL)
    AND ("status" <> 'waiting' OR "notified_at" IS NULL));
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_notice_check"
  CHECK (("notified_at" IS NULL) = ("notice_channel" IS NULL)
    AND (COALESCE("notice_channel" = 'email', false)) = ("notice_result" IS NOT NULL)
    AND "email_count" BETWEEN 0 AND 3);

-- Row-level security (ADR 0005).
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waitlist_entries"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
