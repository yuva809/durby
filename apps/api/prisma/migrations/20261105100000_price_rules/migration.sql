-- Price rules: prices per location and time (docs/modules/catalog.md → Price rules, ADR 0030). Expand only: a new
-- table that older releases ignore.

-- CreateEnum
CREATE TYPE "price_rule_kind" AS ENUM ('fixed', 'percent_off');

-- CreateTable
CREATE TABLE "price_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location_id" UUID,
    "product_id" UUID,
    "category_id" UUID,
    "kind" "price_rule_kind" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starts_at" TEXT,
    "ends_at" TEXT,
    "valid_from" DATE,
    "valid_until" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_rules_tenant_id_location_id_idx" ON "price_rules"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_tenant_id_id_key" ON "price_rules"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

-- One target: a product or a category. A percentage only on categories, in (0, 100]; a fixed price >= 0.
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_target_check"
  CHECK (("product_id" IS NULL) <> ("category_id" IS NULL));
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_value_check"
  CHECK (("kind" = 'fixed' AND "value" >= 0)
      OR ("kind" = 'percent_off' AND "product_id" IS NULL AND "value" > 0 AND "value" <= 100));
-- Local HH:mm, both or neither, never the same; weekdays from a fixed set; dates in order.
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_hours_check"
  CHECK ((("starts_at" IS NULL) = ("ends_at" IS NULL))
     AND ("starts_at" IS NULL OR ("starts_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                                  AND "ends_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                                  AND "starts_at" <> "ends_at")));
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_days_check"
  CHECK ("days" <@ ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::TEXT[]);
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_dates_check"
  CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_from" <= "valid_until");
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 60);

-- Row-level security (ADR 0005). Rules are configuration: changed and deleted freely, audited.
ALTER TABLE "price_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "price_rules"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
