-- Items that were never stocked, sold or used in a recipe may be deleted (ADR 0077, as ADR 0024 for products).
-- The inventory migration revoked DELETE; give it back on stock items only, without TRUNCATE. Items with stock
-- history stay: their rows reference the item with ON DELETE RESTRICT, so the delete fails and the item is archived.
GRANT DELETE ON "stock_items" TO durby_app;
