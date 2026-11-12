-- CreateEnum
CREATE TYPE "pos_bill_kind" AS ENUM ('single', 'equal');

-- AlterTable
ALTER TABLE "pos_print_jobs" ADD COLUMN     "check_id" UUID;

-- CreateTable
CREATE TABLE "pos_bills" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "kind" "pos_bill_kind" NOT NULL,
    "share_count" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_bill_orders" (
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "pos_bill_orders_pkey" PRIMARY KEY ("tenant_id","bill_id","order_id")
);

-- CreateTable
CREATE TABLE "pos_bill_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "pos_bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_guest_checks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "share_index" INTEGER NOT NULL DEFAULT 0,
    "gross" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_guest_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_guest_check_shares" (
    "tenant_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "pos_guest_check_shares_pkey" PRIMARY KEY ("tenant_id","check_id","tax_rate")
);

-- CreateTable
CREATE TABLE "pos_bill_cancellations" (
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelled_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_bill_cancellations_pkey" PRIMARY KEY ("tenant_id","bill_id")
);

-- CreateIndex
CREATE INDEX "pos_bills_tenant_id_location_id_created_at_idx" ON "pos_bills"("tenant_id", "location_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_bills_tenant_id_id_key" ON "pos_bills"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_bills_tenant_id_id_location_id_key" ON "pos_bills"("tenant_id", "id", "location_id");

-- CreateIndex
CREATE INDEX "pos_bill_orders_tenant_id_order_id_idx" ON "pos_bill_orders"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "pos_bill_items_tenant_id_bill_id_idx" ON "pos_bill_items"("tenant_id", "bill_id");

-- CreateIndex
CREATE INDEX "pos_bill_items_tenant_id_order_line_id_idx" ON "pos_bill_items"("tenant_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_bill_items_tenant_id_id_key" ON "pos_bill_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "pos_guest_checks_tenant_id_created_at_idx" ON "pos_guest_checks"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_guest_checks_tenant_id_id_key" ON "pos_guest_checks"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_guest_checks_tenant_id_number_key" ON "pos_guest_checks"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "pos_guest_checks_tenant_id_bill_id_share_index_key" ON "pos_guest_checks"("tenant_id", "bill_id", "share_index");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_tenant_id_id_location_id_key" ON "pos_orders"("tenant_id", "id", "location_id");

-- AddForeignKey
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_orders" ADD CONSTRAINT "pos_bill_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_orders" ADD CONSTRAINT "pos_bill_orders_bill_location_fkey" FOREIGN KEY ("tenant_id", "bill_id", "location_id") REFERENCES "pos_bills"("tenant_id", "id", "location_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_orders" ADD CONSTRAINT "pos_bill_orders_order_location_fkey" FOREIGN KEY ("tenant_id", "order_id", "location_id") REFERENCES "pos_orders"("tenant_id", "id", "location_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_tenant_id_bill_id_fkey" FOREIGN KEY ("tenant_id", "bill_id") REFERENCES "pos_bills"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_bill_order_fkey" FOREIGN KEY ("tenant_id", "bill_id", "order_id") REFERENCES "pos_bill_orders"("tenant_id", "bill_id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_order_line_fkey" FOREIGN KEY ("tenant_id", "order_id", "order_line_id") REFERENCES "pos_order_lines"("tenant_id", "order_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_guest_checks" ADD CONSTRAINT "pos_guest_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_guest_checks" ADD CONSTRAINT "pos_guest_checks_tenant_id_bill_id_fkey" FOREIGN KEY ("tenant_id", "bill_id") REFERENCES "pos_bills"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_guest_check_shares" ADD CONSTRAINT "pos_guest_check_shares_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_guest_check_shares" ADD CONSTRAINT "pos_guest_check_shares_tenant_id_check_id_fkey" FOREIGN KEY ("tenant_id", "check_id") REFERENCES "pos_guest_checks"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_cancellations" ADD CONSTRAINT "pos_bill_cancellations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_bill_cancellations" ADD CONSTRAINT "pos_bill_cancellations_tenant_id_bill_id_fkey" FOREIGN KEY ("tenant_id", "bill_id") REFERENCES "pos_bills"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_tenant_id_check_id_fkey" FOREIGN KEY ("tenant_id", "check_id") REFERENCES "pos_guest_checks"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;


-- Shape rules (docs/modules/pos.md → Step 4, ADR 0036).
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_share_count_check"
  CHECK (("kind" = 'equal') = ("share_count" IS NOT NULL) AND ("share_count" IS NULL OR "share_count" BETWEEN 2 AND 20));
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 9999);
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_product_name_check"
  CHECK (char_length("product_name") BETWEEN 1 AND 100);
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_price_check"
  CHECK ("unit_price" >= 0 AND "tax_rate" BETWEEN 0 AND 100);
ALTER TABLE "pos_guest_checks" ADD CONSTRAINT "pos_guest_checks_number_check" CHECK (char_length("number") BETWEEN 1 AND 32);
ALTER TABLE "pos_guest_checks" ADD CONSTRAINT "pos_guest_checks_share_index_check" CHECK ("share_index" BETWEEN 0 AND 20);
ALTER TABLE "pos_guest_check_shares" ADD CONSTRAINT "pos_guest_check_shares_tax_rate_check"
  CHECK ("tax_rate" BETWEEN 0 AND 100);
ALTER TABLE "pos_bill_cancellations" ADD CONSTRAINT "pos_bill_cancellations_reason_check"
  CHECK (char_length("reason") BETWEEN 1 AND 200);
-- Only a bill job prints a check.
ALTER TABLE "pos_print_jobs" ADD CONSTRAINT "pos_print_jobs_check_kind_check"
  CHECK ("check_id" IS NULL OR "kind" = 'bill');
CREATE INDEX "pos_print_jobs_tenant_id_check_id_idx" ON "pos_print_jobs"("tenant_id", "check_id");

-- Append-only (CLAUDE.md rule 7, ADR 0036 §2): bills and checks are never changed or removed; a cancellation is a
-- row of its own. Same protection as tickets (test/support/append-only.ts).
REVOKE UPDATE, DELETE, TRUNCATE ON "pos_bills", "pos_bill_orders", "pos_bill_items", "pos_guest_checks",
  "pos_guest_check_shares", "pos_bill_cancellations" FROM durby_app;
CREATE TRIGGER pos_bills_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_bills"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_bill_orders_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_bill_orders"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_bill_items_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_bill_items"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_guest_checks_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_guest_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_guest_check_shares_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_guest_check_shares"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_bill_cancellations_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_bill_cancellations"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();

-- Row-level security (ADR 0005).
ALTER TABLE "pos_bills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_bills" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_bills"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_bill_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_bill_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_bill_orders"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_bill_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_bill_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_bill_items"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_guest_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_guest_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_guest_checks"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_guest_check_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_guest_check_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_guest_check_shares"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_bill_cancellations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_bill_cancellations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_bill_cancellations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- One open bill job per order and printer becomes one per check and printer (ADR 0036): two checks of one order
-- (a split) can wait for the same printer. Jobs without a check (queued before checks) keep the old rule.
DROP INDEX "pos_print_jobs_open_bill_key";
CREATE UNIQUE INDEX "pos_print_jobs_open_bill_key" ON "pos_print_jobs"("tenant_id", "order_id", "printer_id")
  WHERE "kind" = 'bill' AND "status" IN ('pending', 'claimed') AND "check_id" IS NULL;
CREATE UNIQUE INDEX "pos_print_jobs_open_check_key" ON "pos_print_jobs"("tenant_id", "check_id", "printer_id")
  WHERE "kind" = 'bill' AND "status" IN ('pending', 'claimed') AND "check_id" IS NOT NULL;
