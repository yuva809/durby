-- The warehouse may send more than asked (item 9): a product the branch did not ask for is added to the request at
-- packing as its own line. Its quantity is what was packed; added_at_packing marks that nobody requested it.
-- Expand-only.

ALTER TABLE "stock_request_lines" ADD COLUMN "added_at_packing" BOOLEAN NOT NULL DEFAULT false;
