-- AlterTable (ADR 0070): the guest's seat on a line; nullable, so existing lines and unseated items stay null.
ALTER TABLE "pos_order_lines" ADD COLUMN "seat" SMALLINT;

-- Shape rule: seats are 1–20 when given.
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_seat_check"
  CHECK ("seat" IS NULL OR "seat" BETWEEN 1 AND 20);
