# ADR 0055: Pack size, brand and the invoiced-in unit on vendor invoices

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0038 (units of measurement), ADR 0048 (categories), ADR 0054 (vendor invoice approval)

## Context

Supplier invoices describe goods as packs ("OD Yellow Croakers 5 x 2kg") and often bill per carton. The review set one
unit and one category for all new items and booked every quantity in the item's own unit, so a carton line had to be
converted by hand and the pack size was lost.

## Decisions

1. **Items get a brand and a pack size** (`stock_items.brand`, `pack_count`, `pack_size`, `pack_unit`; expand-only,
   checked: count 1–100000, size above 0 with its unit). In the item's audit snapshot.
2. **Per line on the review**: category (with "+" to add one, and "Set for all" for every line without one), brand
   and pack size (read from the description: "5 x 2kg", "12×400 ML", a lone "1,5 ltr"; ranges like "800-1000gr" are
   not sizes); for a new item also its unit. A matched item starts from its own values, a missing pack size from the
   description; what the person changes is sent as the line's `itemDetails` and set on the item when the invoice is
   approved (audited `inventory.stock_item.updated`; a category is set, never cleared, from an invoice). The line's
   details are kept in the same `vendor_invoice_lines` columns as a new item's.
3. **Invoiced in**: every line may name a unit of measurement (ADR 0038) of its item's unit, with "+" to add one
   (e.g. Carton = 12 pc). Quantity and cost are in that unit; `vendor_invoice_lines.unit_id` keeps it, and approval
   converts to the item's unit (`StockService.importReceipt`, as receipts do). A unit of another base unit is refused
   (`inventory.unit_mismatch`).
4. **Show what was read**: the text rows read from the PDF or photos, under the review, to check against the paper.
5. **Invoice details**: supplier, invoice number and invoice date (as read, editable; the note is the person's own
   again), warehouse; counts above them ("55 items · 16 existing · 39 new · 2 left out"); an unread supplier is marked
   to be filled in from the paper. The approver can correct the number and date too.

## Consequences

- The units list is the organization's own (ADR 0038), not a fixed list: "+" adds what a supplier uses.
- Editing an item's brand and pack size outside an invoice is possible through the api; the item dialog does not
  offer it yet.
