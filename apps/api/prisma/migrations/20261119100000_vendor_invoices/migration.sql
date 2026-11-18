-- Vendor invoices waiting for approval (docs/modules/inventory.md → Vendor invoices, ADR 0051). Read from the
-- supplier's PDF or photo in the browser; approval books one goods receipt. Tenant data, RLS. Expand only.

-- CreateTable
CREATE TABLE "vendor_invoices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "warehouse_id" UUID NOT NULL,
    "supplier" TEXT,
    "invoice_number" TEXT,
    "invoice_date" TEXT,
    "note" TEXT,
    "printed_total" DECIMAL(12,2),
    "file_name" TEXT,
    "source" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "reject_reason" TEXT,
    "document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vendor_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_invoice_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "item_id" UUID,
    "new_item_name" TEXT,
    "new_item_sku" TEXT,
    "new_item_unit" "StockUnit",
    "new_item_category_id" UUID,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "vendor_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_invoices_document_id_key" ON "vendor_invoices"("document_id");
CREATE UNIQUE INDEX "vendor_invoices_tenant_id_id_key" ON "vendor_invoices"("tenant_id", "id");
CREATE UNIQUE INDEX "vendor_invoices_tenant_id_number_key" ON "vendor_invoices"("tenant_id", "number");
CREATE INDEX "vendor_invoices_tenant_id_status_id_idx" ON "vendor_invoices"("tenant_id", "status", "id");
CREATE UNIQUE INDEX "vendor_invoice_lines_tenant_id_invoice_id_position_key" ON "vendor_invoice_lines"("tenant_id", "invoice_id", "position");

-- AddForeignKey
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "stock_documents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "vendor_invoices"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_tenant_id_new_item_category_id_fkey" FOREIGN KEY ("tenant_id", "new_item_category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_status_check"
  CHECK ("status" IN ('pending', 'approved', 'rejected'));
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_source_check"
  CHECK ("source" IN ('pdf', 'scan'));
-- Decided ones say by whom and when; only approved ones have a receipt; only rejected ones a reason.
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_decision_check"
  CHECK (
    ("status" = 'pending' AND "decided_at" IS NULL AND "document_id" IS NULL AND "reject_reason" IS NULL)
    OR ("status" = 'approved' AND "decided_at" IS NOT NULL AND "document_id" IS NOT NULL)
    OR ("status" = 'rejected' AND "decided_at" IS NOT NULL AND "reject_reason" IS NOT NULL)
  );
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_text_check"
  CHECK (
    char_length(coalesce("supplier", '')) <= 100 AND char_length(coalesce("invoice_number", '')) <= 50
    AND char_length(coalesce("invoice_date", '')) <= 20 AND char_length(coalesce("note", '')) <= 500
    AND char_length(coalesce("file_name", '')) <= 200 AND char_length(coalesce("reject_reason", '')) <= 500
  );
-- A line is an existing item or a new one, never both; amounts above 0 / at least 0.
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_item_check"
  CHECK (
    ("item_id" IS NOT NULL AND "new_item_name" IS NULL AND "new_item_unit" IS NULL)
    OR ("item_id" IS NULL AND "new_item_name" IS NOT NULL AND "new_item_unit" IS NOT NULL)
  );
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_amounts_check"
  CHECK ("quantity" > 0 AND "unit_cost" >= 0 AND "position" >= 0);

-- Row-level security (ADR 0005).
ALTER TABLE "vendor_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_invoices"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "vendor_invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_invoice_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_invoice_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
