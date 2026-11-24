-- Reports read model (ADR 0081): three derived tables, rebuildable from the till and the bookings, so their rows are
-- replaced (no append-only triggers). And which send wrote a kitchen ticket, so one send's kitchen and bar tickets count
-- as one round. Expand only: older releases neither read nor write any of it; new columns are nullable or defaulted.

-- AlterTable
ALTER TABLE "pos_kitchen_tickets" ADD COLUMN     "send_id" UUID,
ADD COLUMN     "transferred" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "report_order_facts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "covers" INTEGER,
    "merged_away" BOOLEAN NOT NULL DEFAULT false,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "first_sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "report_order_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_line_facts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_line_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_reservation_facts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "reservation_status" NOT NULL,
    "source" "reservation_source" NOT NULL,
    "party_size" INTEGER NOT NULL,
    "seated_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "report_reservation_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_order_facts_tenant_id_location_id_first_sent_at_idx" ON "report_order_facts"("tenant_id", "location_id", "first_sent_at");

-- CreateIndex
CREATE INDEX "report_order_facts_tenant_id_location_id_closed_at_idx" ON "report_order_facts"("tenant_id", "location_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_order_facts_tenant_id_id_key" ON "report_order_facts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "report_order_facts_tenant_id_order_id_key" ON "report_order_facts"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "report_line_facts_tenant_id_order_id_idx" ON "report_line_facts"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "report_line_facts_tenant_id_location_id_sent_at_idx" ON "report_line_facts"("tenant_id", "location_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_line_facts_tenant_id_id_key" ON "report_line_facts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "report_line_facts_tenant_id_line_id_key" ON "report_line_facts"("tenant_id", "line_id");

-- CreateIndex
CREATE INDEX "report_reservation_facts_tenant_id_location_id_starts_at_idx" ON "report_reservation_facts"("tenant_id", "location_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_reservation_facts_tenant_id_id_key" ON "report_reservation_facts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "report_reservation_facts_tenant_id_reservation_id_key" ON "report_reservation_facts"("tenant_id", "reservation_id");

-- AddForeignKey
ALTER TABLE "report_order_facts" ADD CONSTRAINT "report_order_facts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "report_order_facts" ADD CONSTRAINT "report_order_facts_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "report_line_facts" ADD CONSTRAINT "report_line_facts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "report_line_facts" ADD CONSTRAINT "report_line_facts_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "report_reservation_facts" ADD CONSTRAINT "report_reservation_facts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "report_reservation_facts" ADD CONSTRAINT "report_reservation_facts_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Row-level security (ADR 0005).
ALTER TABLE "report_order_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_order_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_order_facts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "report_line_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_line_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_line_facts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "report_reservation_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_reservation_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_reservation_facts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
