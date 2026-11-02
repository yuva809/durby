-- Undo (docs/modules/reservations.md → R1.6 bookings API, R1.6c): each status change records the times and tables
-- it replaced, so an undo restores exactly them (seat moves the start and may change tables, finish moves the end).
-- Expand-only: nullable / defaulted columns that older code ignores. The table stays append-only (insert only).
ALTER TABLE "reservation_status_changes"
  ADD COLUMN "previous_starts_at" TIMESTAMPTZ(6),
  ADD COLUMN "previous_ends_at" TIMESTAMPTZ(6),
  ADD COLUMN "previous_table_ids" UUID[];
