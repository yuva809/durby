-- Orders module (docs/modules/orders.md, ADR 0044): customers, sales orders of stock items, their lines and timeline;
-- a default sale price on stock items. Expand only: older releases ignore the new column and tables.

-- CreateEnum
CREATE TYPE "sales_order_status" AS ENUM ('draft', 'confirmed', 'picking', 'packed', 'dispatched', 'delivered', 'cancelled');

-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN "sale_price" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "order_customers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "note" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "sales_order_status" NOT NULL DEFAULT 'draft',
    "customer_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "requested_date" DATE,
    "delivery_address" TEXT,
    "note" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "sales_order_status" NOT NULL,
    "note" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_customers_tenant_id_id_key" ON "order_customers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_tenant_id_id_key" ON "sales_orders"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_tenant_id_number_key" ON "sales_orders"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "sales_orders_tenant_id_location_id_id_idx" ON "sales_orders"("tenant_id", "location_id", "id");

-- CreateIndex
CREATE INDEX "sales_orders_tenant_id_customer_id_idx" ON "sales_orders"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "sales_orders_tenant_id_status_idx" ON "sales_orders"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_tenant_id_id_key" ON "sales_order_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_tenant_id_order_id_item_id_key" ON "sales_order_lines"("tenant_id", "order_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_events_tenant_id_id_key" ON "sales_order_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sales_order_events_tenant_id_order_id_id_idx" ON "sales_order_events"("tenant_id", "order_id", "id");

-- AddForeignKey
ALTER TABLE "order_customers" ADD CONSTRAINT "order_customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "order_customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_sale_price_check"
  CHECK ("sale_price" IS NULL OR "sale_price" >= 0);

ALTER TABLE "order_customers" ADD CONSTRAINT "order_customers_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 120 AND "name" = btrim("name"));
ALTER TABLE "order_customers" ADD CONSTRAINT "order_customers_code_check"
  CHECK ("code" IS NULL OR (char_length("code") BETWEEN 1 AND 30 AND "code" = btrim("code")));
-- Codes are unique among active customers.
CREATE UNIQUE INDEX "order_customers_active_code_key" ON "order_customers"("tenant_id", "code")
  WHERE "archived_at" IS NULL AND "code" IS NOT NULL;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_total_check" CHECK ("total" >= 0);
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_amounts_check"
  CHECK ("unit_price" >= 0 AND "line_total" >= 0);

-- The timeline is append-only (CLAUDE.md rule 7); orders and customers change but are never deleted.
CREATE FUNCTION orders_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER sales_order_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "sales_order_events"
  FOR EACH STATEMENT EXECUTE FUNCTION orders_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON "sales_order_events" FROM durby_app;
REVOKE DELETE, TRUNCATE ON "sales_orders", "order_customers" FROM durby_app;

-- Row-level security (ADR 0005) on every new table.
ALTER TABLE "order_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_customers"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_orders"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_order_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_order_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales_order_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_order_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_order_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Plan contents (ADR 0009): `orders` joins every plan with inventory. One audit row per organization on a changed plan
-- (`platform.plan.features_changed`, actor `migration`), as in reservations_features.
DO $$
DECLARE
  plan_row record;
  org record;
  before_features jsonb;
  after_features jsonb;
BEGIN
  FOR plan_row IN
    SELECT p."id", p."key" FROM "plans" p
    WHERE EXISTS (SELECT 1 FROM "plan_features" f WHERE f."plan_id" = p."id" AND f."feature_key" = 'inventory')
  LOOP
    SELECT coalesce(jsonb_agg(f ORDER BY f), '[]'::jsonb) INTO before_features FROM (
      SELECT CASE WHEN "limits" IS NULL THEN "feature_key" ELSE "feature_key" || ':' || "limits"::text END AS f
      FROM "plan_features" WHERE "plan_id" = plan_row."id"
    ) s;

    INSERT INTO "plan_features" ("plan_id", "feature_key", "updated_at")
    VALUES (plan_row."id", 'orders', now())
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
