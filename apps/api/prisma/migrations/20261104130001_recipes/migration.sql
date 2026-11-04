-- Inventory Step 2: recipes, the station a warehouse supplies, consumption documents (docs/modules/inventory.md → Step 2,
-- ADR 0028). Expand only: older releases ignore the new columns and table.

-- AlterTable
ALTER TABLE "stock_documents" ADD COLUMN     "source_ticket_id" UUID;

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "supplies_station" "prep_station";

-- CreateTable
CREATE TABLE "recipe_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipe_lines_tenant_id_id_key" ON "recipe_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_lines_tenant_id_product_id_item_id_key" ON "recipe_lines"("tenant_id", "product_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_tenant_id_source_ticket_id_key" ON "stock_documents"("tenant_id", "source_ticket_id");

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_quantity_check" CHECK ("quantity" > 0);

-- A consumption is booked for exactly one kitchen ticket; other documents have none.
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_source_check"
  CHECK (("kind" = 'consumption') = ("source_ticket_id" IS NOT NULL));

-- At most one active warehouse per location supplies each station.
CREATE UNIQUE INDEX "warehouses_supplies_station_key" ON "warehouses"("tenant_id", "location_id", "supplies_station")
  WHERE "supplies_station" IS NOT NULL AND "archived_at" IS NULL;

-- Row-level security (ADR 0005). Recipes are configuration: replaced as a whole, so lines may be deleted.
ALTER TABLE "recipe_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipe_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recipe_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
