-- Guests' marketing consent (R2.3a): appended grant/withdraw rows, apart from bookings. Expand only: one new table;
-- a rollback needs nothing.

-- CreateTable
CREATE TABLE "guest_marketing_consents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "reservation_id" UUID,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_marketing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_marketing_consents_tenant_id_guest_id_created_at_idx" ON "guest_marketing_consents"("tenant_id", "guest_id", "created_at");

-- AddForeignKey
ALTER TABLE "guest_marketing_consents" ADD CONSTRAINT "guest_marketing_consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guest_marketing_consents" ADD CONSTRAINT "guest_marketing_consents_tenant_id_guest_id_fkey" FOREIGN KEY ("tenant_id", "guest_id") REFERENCES "reservation_guests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guest_marketing_consents" ADD CONSTRAINT "guest_marketing_consents_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "guest_marketing_consents" ADD CONSTRAINT "guest_marketing_consents_source_check"
  CHECK ("source" IN ('online_booking'));

-- Append-only (CLAUDE.md rule 7): a withdrawal is a new row.
REVOKE UPDATE, DELETE, TRUNCATE ON "guest_marketing_consents" FROM durby_app;
CREATE TRIGGER guest_marketing_consents_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "guest_marketing_consents"
  FOR EACH STATEMENT EXECUTE FUNCTION reservations_append_only();

-- Row-level security (ADR 0005).
ALTER TABLE "guest_marketing_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guest_marketing_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guest_marketing_consents"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
