-- Picking and delivery (docs/modules/orders.md → Step 3, ADR 0044). Own migration: values added to an enum can't be
-- used in the transaction that adds them. Expand only: older releases never write them.
ALTER TYPE "stock_document_kind" ADD VALUE 'issue';
ALTER TYPE "stock_document_kind" ADD VALUE 'restock';
ALTER TYPE "sales_order_status" ADD VALUE 'returned' BEFORE 'cancelled';
