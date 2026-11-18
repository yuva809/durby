-- ADR 0057: the warehouses a member may work in, on the membership. Empty = every warehouse at its locations; with ids,
-- only those for warehouse work. Expand only: a new column with an empty default.
ALTER TABLE "memberships" ADD COLUMN "warehouse_ids" UUID[] NOT NULL DEFAULT '{}';

-- At most a few hundred per member; never a NULL inside.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_warehouse_ids_check"
  CHECK (cardinality("warehouse_ids") <= 500 AND array_position("warehouse_ids", NULL) IS NULL);
