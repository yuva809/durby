-- A delivery (ADR 0080): goods a branch received out of In transit when branches keep no stock of their own.
-- Its own migration: a new enum value can't be used in the transaction that adds it. Expand only.
ALTER TYPE "stock_document_kind" ADD VALUE 'delivery';
