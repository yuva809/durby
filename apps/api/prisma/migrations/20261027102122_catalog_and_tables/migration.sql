-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dining_tables" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "area" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dining_tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenant_id_id_key" ON "product_categories"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "products_tenant_id_category_id_idx" ON "products"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "dining_tables_tenant_id_location_id_idx" ON "dining_tables"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_tenant_id_id_key" ON "dining_tables"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape rules (docs/modules/catalog.md, docs/modules/pos.md). Names are trimmed by the api; the checks are the backstop.
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_sort_order_check" CHECK ("sort_order" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
ALTER TABLE "products" ADD CONSTRAINT "products_description_check"
  CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 500);
ALTER TABLE "products" ADD CONSTRAINT "products_price_check" CHECK ("price" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_check" CHECK ("tax_rate" BETWEEN 0 AND 100);
ALTER TABLE "products" ADD CONSTRAINT "products_sort_order_check" CHECK ("sort_order" >= 0);
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 50 AND "name" = btrim("name"));
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_area_check"
  CHECK ("area" IS NULL OR (char_length("area") BETWEEN 1 AND 50 AND "area" = btrim("area")));
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_seats_check" CHECK ("seats" BETWEEN 1 AND 100);
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_sort_order_check" CHECK ("sort_order" >= 0);

-- Names are unique among non-archived rows (archived ones keep theirs for history).
CREATE UNIQUE INDEX "product_categories_active_name_key" ON "product_categories"("tenant_id", "name")
  WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "products_active_name_key" ON "products"("tenant_id", "category_id", "name")
  WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "dining_tables_active_name_key" ON "dining_tables"("tenant_id", "location_id", "name")
  WHERE "archived_at" IS NULL;

-- Archived, never deleted (orders and guest checks reference them, ADR 0016 §5).
REVOKE DELETE, TRUNCATE ON "product_categories", "products", "dining_tables" FROM durby_app;

-- Row-level security (ADR 0005).
ALTER TABLE "product_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_categories"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "products"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "dining_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dining_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dining_tables"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Plan contents (ADR 0009): the new `catalog` feature joins every seeded plan. One audit row per organization on a
-- changed plan (`platform.plan.features_changed`, actor `migration`), written per tenant with app.tenant_id set so
-- FORCE RLS on audit_logs stays on. `features`: sorted keys, `key:<limits json>` where a plan sets limits.
DO $$
DECLARE
  plan_row record;
  org record;
  before_features jsonb;
  after_features jsonb;
BEGIN
  FOR plan_row IN
    SELECT "id", "key" FROM "plans" WHERE "key" IN ('inventory', 'inventory_billing', 'full') ORDER BY "key"
  LOOP
    SELECT coalesce(jsonb_agg(f ORDER BY f), '[]'::jsonb) INTO before_features FROM (
      SELECT CASE WHEN "limits" IS NULL THEN "feature_key" ELSE "feature_key" || ':' || "limits"::text END AS f
      FROM "plan_features" WHERE "plan_id" = plan_row."id"
    ) s;

    INSERT INTO "plan_features" ("plan_id", "feature_key", "updated_at")
    VALUES (plan_row."id", 'catalog', now())
    ON CONFLICT ("plan_id", "feature_key") DO NOTHING;

    SELECT coalesce(jsonb_agg(f ORDER BY f), '[]'::jsonb) INTO after_features FROM (
      SELECT CASE WHEN "limits" IS NULL THEN "feature_key" ELSE "feature_key" || ':' || "limits"::text END AS f
      FROM "plan_features" WHERE "plan_id" = plan_row."id"
    ) s;

    CONTINUE WHEN before_features = after_features;
    FOR org IN SELECT "id" FROM "organizations" WHERE "plan_id" = plan_row."id" ORDER BY "id" LOOP
      PERFORM set_config('app.tenant_id', org.id::text, true);
      INSERT INTO "audit_logs"
        ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
      VALUES
        (org.id, 'system', 'migration', 'platform.plan.features_changed', 'plan', plan_row."id",
         jsonb_build_object('id', plan_row."id", 'key', plan_row."key", 'features', before_features),
         jsonb_build_object('id', plan_row."id", 'key', plan_row."key", 'features', after_features));
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
