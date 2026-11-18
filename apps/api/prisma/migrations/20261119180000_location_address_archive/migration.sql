-- ADR 0056: a branch's address, and archiving a branch (hidden from lists and pickers, its data kept; deleting stays
-- possible only while nothing points at it). Expand-only: new nullable columns.
ALTER TABLE "locations"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "archived_at" TIMESTAMPTZ(6);

ALTER TABLE "locations" ADD CONSTRAINT "locations_address_check"
  CHECK ("address" IS NULL OR char_length("address") BETWEEN 1 AND 200);
