-- Reservations R0.5 (docs/modules/reservations.md, docs/modules/pos.md → Covers): guests at the table.
-- Expand-only (ADR 0004): a nullable column the previous release neither reads nor writes.
ALTER TABLE "pos_orders" ADD COLUMN "covers" INTEGER;

-- Hand-written: Prisma cannot express CHECK constraints. Same range as ORDER_MAX_COVERS.
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_covers_check" CHECK ("covers" BETWEEN 1 AND 100);
