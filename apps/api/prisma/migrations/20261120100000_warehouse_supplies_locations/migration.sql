-- ADR 0067: a warehouse supplies the branches ticked on it; a branch with none ticked anywhere is supplied by the main
-- warehouse. One supplier per branch is kept by the api (under a lock). Expand-only: a new column, empty by default.
ALTER TABLE "warehouses" ADD COLUMN "supplies_location_ids" UUID[] NOT NULL DEFAULT '{}';

-- At most a few hundred branches; never a NULL inside; the transit warehouse and the main one supply none themselves.
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_supplies_location_ids_check"
  CHECK (
    cardinality("supplies_location_ids") <= 500
    AND array_position("supplies_location_ids", NULL) IS NULL
    AND (cardinality("supplies_location_ids") = 0 OR NOT ("is_transit" OR "is_main"))
  );
