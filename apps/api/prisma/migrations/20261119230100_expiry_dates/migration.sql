-- ADR 0062: expiry dates. Expand only: nullable columns, nothing backfilled (stock received before has no date).
-- stock_levels: the earliest date of what is in stock; stock_movements: the date goods came with (receipts) or were
-- carried along with (transfers); vendor_invoice_lines: as printed, booked on approval.
ALTER TABLE "stock_levels" ADD COLUMN IF NOT EXISTS "expires_on" DATE;
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "expires_on" DATE;
ALTER TABLE "vendor_invoice_lines" ADD COLUMN IF NOT EXISTS "expires_on" DATE;
