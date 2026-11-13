-- Persist each table's normalized location on its restaurant's floor plan.
ALTER TABLE "dining_tables"
  ADD COLUMN "floor_x" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "floor_y" INTEGER NOT NULL DEFAULT 100;

WITH numbered AS (
  SELECT "tenant_id", "id",
    row_number() OVER (PARTITION BY "tenant_id", "location_id" ORDER BY "sort_order", "name", "id") - 1 AS n
  FROM "dining_tables"
)
UPDATE "dining_tables" AS t
SET "floor_x" = 100 + ((numbered.n % 6) * 160),
    "floor_y" = 120 + (((numbered.n / 6) % 5) * 170)
FROM numbered
WHERE t."tenant_id" = numbered."tenant_id" AND t."id" = numbered."id";

ALTER TABLE "dining_tables"
  ADD CONSTRAINT "dining_tables_floor_x_check" CHECK ("floor_x" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "dining_tables_floor_y_check" CHECK ("floor_y" BETWEEN 0 AND 1000);
