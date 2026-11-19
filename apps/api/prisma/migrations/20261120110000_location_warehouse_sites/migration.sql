-- ADR 0068: a warehouse added without a location gets its own place, named like it. Such a place is no branch: the
-- Branches page and the branch pickers leave it out; staff are given access to it like to a branch. Expand-only.
ALTER TABLE "locations" ADD COLUMN "is_warehouse_site" BOOLEAN NOT NULL DEFAULT false;
