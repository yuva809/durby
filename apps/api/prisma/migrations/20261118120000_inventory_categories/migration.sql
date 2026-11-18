-- Categories for stock items, with a description, a parent ("secondary") category and a tile image
-- (docs/modules/inventory.md → Categories, ADR 0048). One category list per organization: the catalog's. Expand only.

-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN "description" TEXT,
ADD COLUMN "parent_id" UUID;

-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN "category_id" UUID;

-- CreateTable
CREATE TABLE "product_category_images" (
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "content_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_category_images_pkey" PRIMARY KEY ("tenant_id","category_id")
);

-- CreateIndex
CREATE INDEX "product_categories_tenant_id_parent_id_idx" ON "product_categories"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "stock_items_tenant_id_category_id_idx" ON "stock_items"("tenant_id", "category_id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_category_images" ADD CONSTRAINT "product_category_images_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_category_images" ADD CONSTRAINT "product_category_images_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_description_check"
  CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 500);
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_not_self_check"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

ALTER TABLE "product_category_images" ADD CONSTRAINT "product_category_images_shape_check"
  CHECK ("content_type" IN ('image/webp', 'image/png', 'image/jpeg')
         AND octet_length("data") BETWEEN 1 AND 307200);

-- Row-level security (ADR 0005).
ALTER TABLE "product_category_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_category_images" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_category_images"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
