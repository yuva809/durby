-- Branches without a store (ADR 0080, orders.branchStores off): a request then names no destination warehouse, and
-- its goods leave In transit as a delivery. Expand only: requests with a destination stay as they are.
ALTER TABLE "stock_requests" ALTER COLUMN "to_warehouse_id" DROP NOT NULL;

-- A delivery belongs to its branch request.
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_delivery_check"
  CHECK ("kind" <> 'delivery' OR "source_request_id" IS NOT NULL);
