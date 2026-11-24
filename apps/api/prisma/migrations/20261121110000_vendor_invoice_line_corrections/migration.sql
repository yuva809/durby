-- Correction of an approved vendor invoice line (ADR 0078): the corrected quantity and cost, why, and the two stock
-- documents that booked the change (the reversal and the new receipt). Expand only: older releases ignore the table.

-- CreateTable
CREATE TABLE "vendor_invoice_line_corrections" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "reversal_document_id" UUID NOT NULL,
    "receipt_document_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_invoice_line_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_invoice_line_corrections_tenant_id_line_id_created_a_idx" ON "vendor_invoice_line_corrections"("tenant_id", "line_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_invoice_line_corrections_tenant_id_id_key" ON "vendor_invoice_line_corrections"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_invoice_lines_tenant_id_id_key" ON "vendor_invoice_lines"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "vendor_invoice_line_corrections" ADD CONSTRAINT "vendor_invoice_line_corrections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vendor_invoice_line_corrections" ADD CONSTRAINT "vendor_invoice_line_corrections_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "vendor_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vendor_invoice_line_corrections" ADD CONSTRAINT "vendor_invoice_line_corrections_tenant_id_line_id_fkey" FOREIGN KEY ("tenant_id", "line_id") REFERENCES "vendor_invoice_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- A correction is a record of what was booked: it is never edited or removed (ADR 0078, ADR 0027).
-- The trigger function is generic: it names the table in its message.
CREATE TRIGGER vendor_invoice_line_corrections_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "vendor_invoice_line_corrections"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_requests_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON "vendor_invoice_line_corrections" FROM durby_app;

-- Row-level security (ADR 0005).
ALTER TABLE "vendor_invoice_line_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_invoice_line_corrections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_invoice_line_corrections"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
