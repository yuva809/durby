-- Inventory Step 5: units of measurement, variant attributes, item variants and bills of materials
-- (docs/modules/inventory.md → Step 5, ADR 0038). Expand only: older releases ignore the new columns and tables.

-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN     "parent_item_id" UUID,
ADD COLUMN     "variant_values" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "base_unit" "stock_unit" NOT NULL,
    "factor" DECIMAL(14,6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_attributes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "values" TEXT[],
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variant_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boms" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "output_quantity" DECIMAL(14,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "boms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bom_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenant_id_parent_item_id_variant_values_key" ON "stock_items"("tenant_id", "parent_item_id", "variant_values");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_tenant_id_id_key" ON "units_of_measure"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_attributes_tenant_id_id_key" ON "variant_attributes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "boms_tenant_id_id_key" ON "boms"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "boms_tenant_id_item_id_key" ON "boms"("tenant_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "bom_lines_tenant_id_id_key" ON "bom_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bom_lines_tenant_id_bom_id_item_id_key" ON "bom_lines"("tenant_id", "bom_id", "item_id");

-- CreateIndex
CREATE INDEX "bom_lines_tenant_id_item_id_idx" ON "bom_lines"("tenant_id", "item_id");

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_parent_item_id_fkey" FOREIGN KEY ("tenant_id", "parent_item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "variant_attributes" ADD CONSTRAINT "variant_attributes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "boms" ADD CONSTRAINT "boms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "boms" ADD CONSTRAINT "boms_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_tenant_id_bom_id_fkey" FOREIGN KEY ("tenant_id", "bom_id") REFERENCES "boms"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- A variant has values exactly when it has a parent, and is never its own parent.
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_variant_check"
  CHECK (("parent_item_id" IS NULL) = (cardinality(coalesce("variant_values", ARRAY[]::TEXT[])) = 0)
         AND ("parent_item_id" IS NULL OR "parent_item_id" <> "id"));

ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_symbol_check"
  CHECK (char_length("symbol") BETWEEN 1 AND 20 AND "symbol" = btrim("symbol"));
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_factor_check" CHECK ("factor" > 0);

ALTER TABLE "variant_attributes" ADD CONSTRAINT "variant_attributes_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
ALTER TABLE "variant_attributes" ADD CONSTRAINT "variant_attributes_values_check"
  CHECK (cardinality("values") BETWEEN 1 AND 50);

ALTER TABLE "boms" ADD CONSTRAINT "boms_output_quantity_check" CHECK ("output_quantity" > 0);
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_quantity_check" CHECK ("quantity" > 0);

-- Names are unique among the active ones, like stock items.
CREATE UNIQUE INDEX "units_of_measure_active_name_key" ON "units_of_measure"("tenant_id", "name")
  WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "variant_attributes_active_name_key" ON "variant_attributes"("tenant_id", "name")
  WHERE "archived_at" IS NULL;

-- Row-level security (ADR 0005). Units and attributes are archived, never deleted; bills of materials are
-- configuration, replaced as a whole and deleted freely, like recipes.
ALTER TABLE "units_of_measure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "units_of_measure" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "units_of_measure"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "variant_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "variant_attributes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "variant_attributes"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "boms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "boms" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "boms"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "bom_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bom_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bom_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
