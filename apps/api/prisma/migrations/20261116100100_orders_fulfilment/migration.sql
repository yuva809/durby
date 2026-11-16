-- Picking and delivery (docs/modules/orders.md → Step 3, ADR 0044): picked quantities, delivery details, and the
-- sales order a stock document was booked for. Expand only: older releases ignore the new columns.

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN "picked_quantity" DECIMAL(14,3);

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN "driver_name" TEXT,
ADD COLUMN "driver_phone" TEXT,
ADD COLUMN "vehicle" TEXT,
ADD COLUMN "dispatched_at" TIMESTAMPTZ(6),
ADD COLUMN "delivered_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "stock_documents" ADD COLUMN "source_order_id" UUID;

-- CreateIndex
CREATE INDEX "stock_documents_tenant_id_source_order_id_idx" ON "stock_documents"("tenant_id", "source_order_id");


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_picked_quantity_check"
  CHECK ("picked_quantity" IS NULL OR "picked_quantity" >= 0);

-- Goods out and back in for a sales order name it (no FK: the orders module owns the table, like source_ticket_id).
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_source_order_check"
  CHECK (("source_order_id" IS NOT NULL) = ("kind" IN ('issue', 'restock')));
