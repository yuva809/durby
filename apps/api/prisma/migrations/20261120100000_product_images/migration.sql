-- CreateTable
CREATE TABLE "product_images" (
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "content_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("tenant_id","product_id")
);

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Shape rules (ADR 0049): the same types and size limit as category tile images (ADR 0048).
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_shape_check"
  CHECK ("content_type" IN ('image/webp', 'image/png', 'image/jpeg')
         AND octet_length("data") BETWEEN 1 AND 307200);

-- Row-level security (ADR 0005).
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_images" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_images"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
