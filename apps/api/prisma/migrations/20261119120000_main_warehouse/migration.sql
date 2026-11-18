-- ADR 0053: one warehouse may supply every branch; branch requests then always come from it. Expand-only.
ALTER TABLE "warehouses" ADD COLUMN "is_main" BOOLEAN NOT NULL DEFAULT false;

-- The transit warehouse never is the main one.
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_main_not_transit_check"
  CHECK (NOT ("is_main" AND "is_transit"));

-- At most one active main warehouse per organization.
CREATE UNIQUE INDEX "warehouses_one_main_key" ON "warehouses"("tenant_id")
  WHERE "is_main" AND "archived_at" IS NULL;
