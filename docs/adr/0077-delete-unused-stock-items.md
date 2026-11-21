# ADR 0077: Delete unused stock items

- Status: accepted
- Date: 2026-11-21
- Builds on [ADR 0027](0027-inventory-stock-ledger.md) (stock history is append-only) and [ADR 0024](0024-catalog-bulk-delete.md)
  (deleting never-sold products).

## Context

An item entered by mistake, or a duplicate, can only be archived today. Archived items stay in the list and in the
database. People asked for a delete as well.

## Decision

1. **Delete removes an item only when nothing refers to it.** Stock levels, movements, documents, recipes, requests and
   sales keep the item with `ON DELETE RESTRICT`, so the database refuses the delete for any item with history. The API
   answers `inventory.item_in_use`, and the item stays, to be archived.
2. **Permission `inventory.items.delete`** (the owner gets it; other roles as set in the permission matrix).
3. **Audit `inventory.stock_item.deleted`** with the item before the delete.
4. **The app role gets DELETE on `stock_items` only**, without TRUNCATE (ADR 0002 stays: no ownership, no BYPASSRLS).

## Consequences

- An unused item disappears from every list. An item with history can only be archived, as before.
- Recipe or unit rows that cascade with the item are removed with it.
