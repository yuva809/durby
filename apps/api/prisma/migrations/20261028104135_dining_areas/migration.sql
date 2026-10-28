-- Areas as their own records (docs/modules/pos.md → Areas, ADR 0016 §9). Expand phase (ADR 0004): the old
-- `dining_tables.area` text stays and the app keeps it equal to the area's name, so the previous release still
-- reads correct areas; a contract migration drops it later. Prisma's diff also proposed dropping the hand-written
-- pos FKs and indexes; those statements were removed.
-- AlterTable
ALTER TABLE "dining_tables" ADD COLUMN     "area_id" UUID;

-- CreateTable
CREATE TABLE "dining_areas" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dining_areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dining_areas_tenant_id_id_key" ON "dining_areas"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dining_areas_tenant_id_location_id_id_key" ON "dining_areas"("tenant_id", "location_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dining_areas_tenant_id_location_id_name_key" ON "dining_areas"("tenant_id", "location_id", "name");

-- CreateIndex
CREATE INDEX "dining_tables_tenant_id_area_id_idx" ON "dining_tables"("tenant_id", "area_id");

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_tenant_id_location_id_area_id_fkey" FOREIGN KEY ("tenant_id", "location_id", "area_id") REFERENCES "dining_areas"("tenant_id", "location_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "dining_areas" ADD CONSTRAINT "dining_areas_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "dining_areas" ADD CONSTRAINT "dining_areas_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape rules.
ALTER TABLE "dining_areas" ADD CONSTRAINT "dining_areas_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 50 AND "name" = btrim("name"));
ALTER TABLE "dining_areas" ADD CONSTRAINT "dining_areas_sort_order_check" CHECK ("sort_order" >= 0);

-- Row-level security (ADR 0005).
ALTER TABLE "dining_areas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dining_areas" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dining_areas"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Backfill: one area per distinct (location, area text), in name order, and tables pointed at it. Per tenant with
-- app.tenant_id set, so FORCE RLS stays on. A data move, no audit rows (like the rbac backfill).
DO $$
DECLARE
  org RECORD;
BEGIN
  -- organizations has no RLS; dining_tables shows no rows before app.tenant_id is set (FORCE RLS).
  FOR org IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO "dining_areas" ("tenant_id", "location_id", "name", "sort_order", "updated_at")
      SELECT t."tenant_id", t."location_id", t."area",
             (row_number() OVER (PARTITION BY t."location_id" ORDER BY t."area") - 1)::int, now()
      FROM (SELECT DISTINCT "tenant_id", "location_id", "area" FROM "dining_tables"
            WHERE "tenant_id" = org.id AND "area" IS NOT NULL) t
      ON CONFLICT ("tenant_id", "location_id", "name") DO NOTHING;
    UPDATE "dining_tables" dt SET "area_id" = a."id"
      FROM "dining_areas" a
      WHERE dt."tenant_id" = org.id AND a."tenant_id" = org.id
        AND a."location_id" = dt."location_id" AND a."name" = dt."area";
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
