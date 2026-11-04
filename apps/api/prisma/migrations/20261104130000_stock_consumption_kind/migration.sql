-- Sales consumption documents (docs/modules/inventory.md → Consumption, ADR 0028). Own migration: a value added to an
-- enum can't be used in the transaction that adds it.
ALTER TYPE "stock_document_kind" ADD VALUE 'consumption';
