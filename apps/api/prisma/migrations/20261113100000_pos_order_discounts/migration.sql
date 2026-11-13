-- CreateEnum
CREATE TYPE "pos_discount_kind" AS ENUM ('percent', 'amount');

-- AlterTable
ALTER TABLE "pos_bill_items" ADD COLUMN     "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "pos_order_discounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID,
    "kind" "pos_discount_kind" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "voids_discount_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_order_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_discount_lines" (
    "tenant_id" UUID NOT NULL,
    "discount_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "pos_order_discount_lines_pkey" PRIMARY KEY ("tenant_id","discount_id","order_line_id")
);

-- CreateIndex
CREATE INDEX "pos_order_discounts_tenant_id_order_id_idx" ON "pos_order_discounts"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_order_discounts_tenant_id_id_key" ON "pos_order_discounts"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "pos_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_discount_lines" ADD CONSTRAINT "pos_order_discount_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_discount_lines" ADD CONSTRAINT "pos_order_discount_lines_tenant_id_discount_id_fkey" FOREIGN KEY ("tenant_id", "discount_id") REFERENCES "pos_order_discounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pos_order_discount_lines" ADD CONSTRAINT "pos_order_discount_lines_order_line_fkey" FOREIGN KEY ("tenant_id", "order_id", "order_line_id") REFERENCES "pos_order_lines"("tenant_id", "order_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Shape rules (docs/modules/pos.md → Step 4b, ADR 0036 §5).
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_value_check"
  CHECK ("value" > 0 AND ("kind" <> 'percent' OR "value" <= 100));
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_reason_check"
  CHECK (char_length("reason") BETWEEN 1 AND 40);
ALTER TABLE "pos_order_discount_lines" ADD CONSTRAINT "pos_order_discount_lines_amount_check"
  CHECK ("amount" <= 0 AND "tax_rate" BETWEEN 0 AND 100);
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_discount_check" CHECK ("discount_amount" <= 0);

-- Append-only (CLAUDE.md rule 7): a discount is never changed; removing one is a new row.
REVOKE UPDATE, DELETE, TRUNCATE ON "pos_order_discounts", "pos_order_discount_lines" FROM durby_app;
CREATE TRIGGER pos_order_discounts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_order_discounts"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();
CREATE TRIGGER pos_order_discount_lines_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "pos_order_discount_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_append_only();

-- Row-level security (ADR 0005).
ALTER TABLE "pos_order_discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_order_discounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_order_discounts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "pos_order_discount_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_order_discount_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_order_discount_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

