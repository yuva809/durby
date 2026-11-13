-- Production orders (docs/modules/inventory.md → Step 5, ADR 0038). Own migration: a value added to an enum can't be
-- used in the transaction that adds it. Expand only: older releases never write it.
ALTER TYPE "stock_document_kind" ADD VALUE 'production';
