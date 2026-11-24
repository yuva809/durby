# ADR 0079: Delete a stock item with its whole history (owners)

- Status: accepted
- Date: 2026-11-24
- An exception to [ADR 0027](0027-inventory-stock-ledger.md) §3 and CLAUDE.md rule 7 (the stock ledger is
  append-only), under the definer rules of [ADR 0006](0006-authentication.md). Extends
  [ADR 0077](0077-delete-unused-stock-items.md) (deleting items that were never stocked).

## Context

An item with stock history can only be archived. AsiaMight's owner asked to delete such items outright: duplicates
made by importing the same vendor invoice twice, test items, products booked by mistake. Archiving hides them, but
the owner wants them gone, history and all, from the app, without a server script.

The ledger is protected in the database: `stock_movements` and `stock_documents` have statement triggers that refuse
UPDATE, DELETE and TRUNCATE, and `durby_app` has no DELETE on them (nor on items, levels and request lines).

## Decision

1. **Owners only.** A new permission `inventory.items.purge` (Manage Staff row "Stock item history", column Delete):
   owners have every key; every other system role is denied it; an owner may give it to a custom role on purpose.
2. **One database function does it**: `purge_stock_item(item uuid)`, `SECURITY DEFINER`, owned by
   `durby_rls_definer`, `search_path` pinned, executable by `durby_app` only, on the ADR 0006 allow-list. It reads the
   tenant from `app.tenant_id` (never a caller-chosen tenant) and names it in every statement (the definer bypasses
   RLS). It deletes, for that one item: invoice line corrections and invoice lines, stock request lines, all its
   movements, documents left with no movements (unless an invoice still points at them), its stock levels, and the
   item. Other items' rows are untouched, so their stock and costs don't change.
3. **Refused** (409 `inventory.item_purge_refused`) when the item is in a recipe or a bill of materials, is on a sales
   order (financial), or has variants: those are changed first.
4. **The append-only triggers stay**, and let through only DELETE by `durby_rls_definer` while the function has set
   `durby.item_purge = on` for its transaction. Nobody can log in as `durby_rls_definer`; `durby_app` still has no
   DELETE on the ledger. The definer gets DELETE on the history tables it clears and SELECT on only the columns it
   filters by (test/support/security-definer.ts lists them).
5. **Audited**: `inventory.stock_item.purged` with the item as it was. The audit log itself stays append-only.
6. **The app**: Delete on an item with history offers "Archive instead" to everyone who may delete, and "Delete with
   all history" to owners, with a warning that past documents change and it cannot be undone.

## Consequences

- Past goods receipts, transfers and requests lose the deleted item's lines; their totals change, and stock reports
  for past dates no longer match what was booked then. That is the owner's explicit choice; the audit log records it.
- Rule 7 now has one named exception. Any further one needs its own ADR.
- `POST /inventory/items/:id/purge` (204); idempotent like the other writes.
