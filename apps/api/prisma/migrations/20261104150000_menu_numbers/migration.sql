-- Menu numbers (ADR 0029): optional, unique per organization among non-archived products,
-- case-insensitive. Expand-only: a nullable column, a check and a partial unique index.
ALTER TABLE "products" ADD COLUMN "menu_number" TEXT;

ALTER TABLE "products" ADD CONSTRAINT "products_menu_number_check"
  CHECK ("menu_number" ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,5}$');

CREATE UNIQUE INDEX "products_active_menu_number_key" ON "products" ("tenant_id", lower("menu_number"))
  WHERE "archived_at" IS NULL AND "menu_number" IS NOT NULL;
