-- Kitchen and bar processing switches (ADR 0031): a ticket that went straight to the bill.
-- Expand-only: a column with a default; older releases ignore it.
ALTER TABLE "pos_kitchen_tickets" ADD COLUMN "direct" BOOLEAN NOT NULL DEFAULT false;
