# ADR 0078: Correct an approved vendor invoice line by reversing entries

- Status: accepted
- Date: 2026-11-21
- Builds on [ADR 0027](0027-inventory-stock-ledger.md) (the stock ledger is append-only) and
  [ADR 0054](0054-vendor-invoice-approval-and-import-data.md) (approving an invoice books one goods receipt).

## Context

Approving a vendor invoice books its goods into stock. A line can be wrong after approval: the quantity or the unit
cost was typed wrong, or the supplier corrected it. Approved invoices are read-only today, and the stock they booked
can't be edited (ADR 0027).

## Decision

1. **A correction is a new entry, never an edit.** Correcting an approved line writes a correction record with the new
   quantity and unit cost, the reason, and the two stock documents it booked.
2. **Two stock documents per correction:** an adjustment that takes the line's current quantity out (reason
   `correction`), and a goods receipt that brings the corrected quantity in at the corrected unit cost. Both are normal
   documents in the ledger, so the stock history stays whole.
3. **The line shows its corrected values** (the latest correction, else what was invoiced). The invoice's own
   totals as printed are not changed.
4. **Permission:** `inventory.invoices.approve` at the invoice's warehouse, the same as approving.
5. **Only approved invoices, with an item.** A pending invoice is changed as before. A line without an item can't be
   corrected.
6. **Audit** `inventory.vendor_invoice.line_corrected`, with the line before and after.

## Consequences

- The correction is one new append-only table, with a reason of 1–200 characters and a positive quantity.
- The removed quantity leaves at the warehouse's current average cost, and the receipt enters at the corrected cost.
  The stock value therefore moves by the difference the correction makes.
- The two documents are posted one after the other. If the correction record fails after the second document,
  the record is written with the documents' ids; this is the one place a failure needs a manual check.
