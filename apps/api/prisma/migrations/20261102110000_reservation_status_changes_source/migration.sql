-- Auto-seat and auto-finish from the till (docs/modules/reservations.md → R1.7): the system's status change records
-- the pos order that caused it, so /host can show "auto-seated from till" with undo (R1.8). No FK: pos_orders belongs
-- to pos; reservations keeps the id only. Expand-only; the table stays append-only.
ALTER TABLE "reservation_status_changes" ADD COLUMN "source_order_id" UUID;
ALTER TABLE "reservation_status_changes" ADD CONSTRAINT "reservation_status_changes_source_check"
  CHECK ("source_order_id" IS NULL OR "actor_kind" = 'system');
