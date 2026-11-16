-- Branch stock requests (docs/modules/orders.md → Branch requests, ADR 0045): a branch's request for goods, its lines
-- through approval, picking and receipt, its timeline; the "In transit" warehouse; the request a stock document was
-- booked for. Expand only: older releases ignore the new tables and columns.

-- CreateEnum
CREATE TYPE "stock_request_status" AS ENUM ('submitted', 'approved', 'picking', 'packed', 'in_transit', 'delivered', 'received', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN "is_transit" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_documents" ADD COLUMN "source_request_id" UUID;

-- CreateTable
CREATE TABLE "stock_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "transfer_number" TEXT,
    "status" "stock_request_status" NOT NULL DEFAULT 'submitted',
    "location_id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "from_warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID NOT NULL,
    "note" TEXT,
    "requested_by_user_id" UUID NOT NULL,
    "driver_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_request_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "approved_quantity" DECIMAL(14,3),
    "picked_quantity" DECIMAL(14,3),
    "received_quantity" DECIMAL(14,3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stock_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_request_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" "stock_request_status" NOT NULL,
    "note" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_documents_tenant_id_source_request_id_idx" ON "stock_documents"("tenant_id", "source_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_requests_tenant_id_id_key" ON "stock_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_requests_tenant_id_number_key" ON "stock_requests"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_requests_tenant_id_transfer_number_key" ON "stock_requests"("tenant_id", "transfer_number");

-- CreateIndex
CREATE INDEX "stock_requests_tenant_id_status_id_idx" ON "stock_requests"("tenant_id", "status", "id");

-- CreateIndex
CREATE INDEX "stock_requests_tenant_id_driver_user_id_idx" ON "stock_requests"("tenant_id", "driver_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_request_lines_tenant_id_id_key" ON "stock_request_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_request_lines_tenant_id_request_id_item_id_key" ON "stock_request_lines"("tenant_id", "request_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_request_events_tenant_id_id_key" ON "stock_request_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_request_events_tenant_id_request_id_id_idx" ON "stock_request_events"("tenant_id", "request_id", "id");

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_tenant_id_from_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "from_warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_tenant_id_to_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "to_warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_tenant_id_request_id_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "stock_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_request_events" ADD CONSTRAINT "stock_request_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_request_events" ADD CONSTRAINT "stock_request_events_tenant_id_request_id_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "stock_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- One "In transit" warehouse per organization.
CREATE UNIQUE INDEX "warehouses_one_transit_key" ON "warehouses"("tenant_id") WHERE "is_transit";

ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_warehouses_check"
  CHECK ("from_warehouse_id" <> "to_warehouse_id");
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_quantities_check"
  CHECK ("quantity" > 0
    AND ("approved_quantity" IS NULL OR "approved_quantity" >= 0)
    AND ("picked_quantity" IS NULL OR "picked_quantity" >= 0)
    AND ("received_quantity" IS NULL OR "received_quantity" >= 0));

-- The timeline is append-only (CLAUDE.md rule 7); requests and their lines change but are never deleted.
CREATE FUNCTION stock_requests_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER stock_request_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_request_events"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_requests_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON "stock_request_events" FROM durby_app;
REVOKE DELETE, TRUNCATE ON "stock_requests", "stock_request_lines" FROM durby_app;

-- Row-level security (ADR 0005) on every new table.
ALTER TABLE "stock_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_requests"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "stock_request_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_request_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_request_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "stock_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_request_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_request_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
