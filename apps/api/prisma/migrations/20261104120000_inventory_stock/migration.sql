-- Inventory Step 1: warehouses, stock items and the stock ledger (docs/modules/inventory.md, ADR 0027).


-- CreateEnum
CREATE TYPE "stock_unit" AS ENUM ('kg', 'g', 'l', 'ml', 'pc');

-- CreateEnum
CREATE TYPE "stock_document_kind" AS ENUM ('receipt', 'adjustment', 'transfer');

-- CreateEnum
CREATE TYPE "stock_adjustment_reason" AS ENUM ('waste', 'breakage', 'count', 'other');

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit" "stock_unit" NOT NULL,
    "min_quantity" DECIMAL(14,3),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "stock_document_kind" NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID,
    "reason" "stock_adjustment_reason",
    "supplier" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "average_cost" DECIMAL(14,4) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("tenant_id","warehouse_id","item_id")
);

-- CreateIndex
CREATE INDEX "warehouses_tenant_id_location_id_idx" ON "warehouses"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenant_id_id_key" ON "warehouses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenant_id_id_key" ON "stock_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_documents_tenant_id_warehouse_id_created_at_idx" ON "stock_documents"("tenant_id", "warehouse_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_tenant_id_id_key" ON "stock_documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_tenant_id_number_key" ON "stock_documents"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_document_id_idx" ON "stock_movements"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_item_id_warehouse_id_idx" ON "stock_movements"("tenant_id", "item_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_id_key" ON "stock_movements"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_tenant_id_to_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "to_warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "stock_documents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_sort_order_check" CHECK ("sort_order" >= 0);
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_min_quantity_check"
  CHECK ("min_quantity" IS NULL OR "min_quantity" >= 0);

-- A transfer names its target (another warehouse); only an adjustment has a reason.
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_transfer_check"
  CHECK (("kind" = 'transfer') = ("to_warehouse_id" IS NOT NULL) AND "to_warehouse_id" IS DISTINCT FROM "warehouse_id");
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_reason_check"
  CHECK (("kind" = 'adjustment') = ("reason" IS NOT NULL));
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_check" CHECK ("quantity" <> 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_cost_check" CHECK ("unit_cost" >= 0);
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_average_cost_check" CHECK ("average_cost" >= 0);

-- Names are unique among non-archived rows (archived ones keep theirs for history).
CREATE UNIQUE INDEX "warehouses_active_name_key" ON "warehouses"("tenant_id", "location_id", "name")
  WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "stock_items_active_name_key" ON "stock_items"("tenant_id", "name")
  WHERE "archived_at" IS NULL;

-- History (CLAUDE.md rule 7, ADR 0027 §3): documents and movements are append-only like pos tickets
-- (test/support/append-only.ts). Warehouses and items are archived, never deleted; levels are a projection,
-- updated but never deleted.
CREATE FUNCTION inventory_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER stock_documents_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_append_only();
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON "stock_documents", "stock_movements" FROM durby_app;
REVOKE DELETE, TRUNCATE ON "warehouses", "stock_items", "stock_levels" FROM durby_app;

-- Row-level security (ADR 0005) on every new table.
ALTER TABLE "warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "warehouses"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_items"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "stock_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_documents"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_movements"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "stock_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_levels" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_levels"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
