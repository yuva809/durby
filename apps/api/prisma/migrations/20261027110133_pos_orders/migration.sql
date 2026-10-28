-- CreateEnum
CREATE TYPE "pos_order_status" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "pos_kitchen_ticket_kind" AS ENUM ('order', 'void');

-- CreateTable
CREATE TABLE "pos_orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "pos_order_status" NOT NULL DEFAULT 'open',
    "opened_by_user_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_kitchen_tickets" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "pos_kitchen_ticket_kind" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "voids_line_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_orders_tenant_id_location_id_status_idx" ON "pos_orders"("tenant_id", "location_id", "status");

-- CreateIndex
CREATE INDEX "pos_orders_tenant_id_table_id_idx" ON "pos_orders"("tenant_id", "table_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_tenant_id_id_key" ON "pos_orders"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_tenant_id_number_key" ON "pos_orders"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "pos_kitchen_tickets_tenant_id_id_key" ON "pos_kitchen_tickets"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_kitchen_tickets_tenant_id_order_id_sequence_key" ON "pos_kitchen_tickets"("tenant_id", "order_id", "sequence");

-- CreateIndex
CREATE INDEX "pos_order_lines_tenant_id_order_id_idx" ON "pos_order_lines"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "pos_order_lines_tenant_id_ticket_id_idx" ON "pos_order_lines"("tenant_id", "ticket_id");

-- CreateIndex
CREATE INDEX "pos_order_lines_tenant_id_voids_line_id_idx" ON "pos_order_lines"("tenant_id", "voids_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_order_lines_tenant_id_id_key" ON "pos_order_lines"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_tenant_id_table_id_fkey" FOREIGN KEY ("tenant_id", "table_id") REFERENCES "dining_tables"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_kitchen_tickets" ADD CONSTRAINT "pos_kitchen_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_kitchen_tickets" ADD CONSTRAINT "pos_kitchen_tickets_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "pos_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "pos_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "pos_kitchen_tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_tenant_id_voids_line_id_fkey" FOREIGN KEY ("tenant_id", "voids_line_id") REFERENCES "pos_order_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Consistency across rows (docs/modules/pos.md → Step 3): an order is at its table's location; a line's ticket
-- and the line it voids belong to the same order. Composite FKs need a matching unique key on the target.
CREATE UNIQUE INDEX "dining_tables_tenant_id_id_location_id_key" ON "dining_tables"("tenant_id", "id", "location_id");
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_table_location_fkey"
  FOREIGN KEY ("tenant_id", "table_id", "location_id") REFERENCES "dining_tables"("tenant_id", "id", "location_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "pos_kitchen_tickets_tenant_id_order_id_id_key" ON "pos_kitchen_tickets"("tenant_id", "order_id", "id");
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_ticket_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id", "ticket_id") REFERENCES "pos_kitchen_tickets"("tenant_id", "order_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "pos_order_lines_tenant_id_order_id_id_key" ON "pos_order_lines"("tenant_id", "order_id", "id");
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_voids_same_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id", "voids_line_id") REFERENCES "pos_order_lines"("tenant_id", "order_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One open order per table.
CREATE UNIQUE INDEX "pos_orders_one_open_per_table_key" ON "pos_orders"("tenant_id", "table_id")
  WHERE "status" = 'open';

-- Shape rules.
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_number_check" CHECK (char_length("number") BETWEEN 1 AND 32);
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_closed_check"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL) AND ("closed_at" IS NULL) = ("closed_by_user_id" IS NULL));
ALTER TABLE "pos_kitchen_tickets" ADD CONSTRAINT "pos_kitchen_tickets_sequence_check" CHECK ("sequence" >= 1);
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_quantity_check"
  CHECK ("quantity" <> 0 AND ("quantity" < 0) = ("voids_line_id" IS NOT NULL));
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_product_name_check"
  CHECK (char_length("product_name") BETWEEN 1 AND 100);
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_note_check"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200);
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_price_check"
  CHECK ("unit_price" >= 0 AND "tax_rate" BETWEEN 0 AND 100);

-- Append-only (CLAUDE.md rule 7): tickets and lines are never changed or removed, corrections are void tickets.
-- Orders change status (open → closed) but are never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON "pos_kitchen_tickets", "pos_order_lines" FROM durby_app;
REVOKE DELETE, TRUNCATE ON "pos_orders" FROM durby_app;

-- Row-level security (ADR 0005).
ALTER TABLE "pos_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_orders"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_kitchen_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_kitchen_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_kitchen_tickets"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_order_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_order_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
