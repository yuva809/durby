-- ADR 0055: an item's brand and pack size (count x size, e.g. 12 x 500 g), and on vendor invoice lines the unit the
-- supplier invoices in (a unit of measurement, e.g. Carton = 12 pc) plus the new item's brand and pack size.
-- Expand-only: new nullable columns.
ALTER TABLE "stock_items"
  ADD COLUMN "brand" TEXT,
  ADD COLUMN "pack_count" INTEGER,
  ADD COLUMN "pack_size" DECIMAL(14,3),
  ADD COLUMN "pack_unit" "stock_unit";

ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_pack_check" CHECK (
  ("brand" IS NULL OR char_length("brand") BETWEEN 1 AND 100)
  AND ("pack_count" IS NULL OR "pack_count" BETWEEN 1 AND 100000)
  AND (("pack_size" IS NULL) = ("pack_unit" IS NULL))
  AND ("pack_size" IS NULL OR "pack_size" > 0)
);

ALTER TABLE "vendor_invoice_lines"
  ADD COLUMN "unit_id" UUID,
  ADD COLUMN "new_item_brand" TEXT,
  ADD COLUMN "new_item_pack_count" INTEGER,
  ADD COLUMN "new_item_pack_size" DECIMAL(14,3),
  ADD COLUMN "new_item_pack_unit" "stock_unit";

ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units_of_measure"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_new_pack_check" CHECK (
  ("new_item_brand" IS NULL OR char_length("new_item_brand") BETWEEN 1 AND 100)
  AND ("new_item_pack_count" IS NULL OR "new_item_pack_count" BETWEEN 1 AND 100000)
  AND (("new_item_pack_size" IS NULL) = ("new_item_pack_unit" IS NULL))
  AND ("new_item_pack_size" IS NULL OR "new_item_pack_size" > 0)
  -- Only a proposed new item carries these.
  AND ("item_id" IS NULL OR ("new_item_brand" IS NULL AND "new_item_pack_count" IS NULL
    AND "new_item_pack_size" IS NULL))
);

CREATE INDEX "vendor_invoice_lines_tenant_id_unit_id_idx" ON "vendor_invoice_lines"("tenant_id", "unit_id");
