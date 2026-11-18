# ADR 0054: Vendor invoices wait for approval; photos and Excel in Import Data

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0044 (Import Data), ADR 0047 (notifications), ADR 0049 (vendor invoice import)

## Context

With ADR 0049 a vendor invoice PDF became a goods receipt the moment someone pressed Import. The distributor (the
operations menu's partner) wants a second pair of eyes before stock is booked: whoever unpacks the goods reads the
invoice, a manager checks and approves it. Suppliers also send photos of paper invoices and scanned PDFs, which ADR
0049 refused. Import Data took only CSV ("Excel: Save as → CSV"), and its page looked like a form rather than a place
to start.

## Decisions

1. **Invoices are stored and wait as pending.** `vendor_invoices` (number series `VIN`, status
   `pending | approved | rejected`, warehouse, supplier, invoice number and date, note, printed total, file name,
   source `pdf | scan`, submitter, decider, reject reason, the goods receipt booked) and `vendor_invoice_lines`
   (position, supplier code, description, either an existing item or a proposed new item `{ name, sku, unit,
categoryId }`, quantity, unit cost). Tenant RLS like every table; checks for status, source, decision fields,
   text lengths, item xor new item and amounts.
2. **Routes** under `/api/v1/inventory/invoices` (`@RequireFeature('inventory')`):

   | Method + path       | Permission                   | Idempotency                 |
   | ------------------- | ---------------------------- | --------------------------- |
   | `GET /?status=`     | `inventory.stock.read`       |                             |
   | `GET /:id`          | `inventory.stock.read`       |                             |
   | `POST /`            | `inventory.stock.receive`    | `completion: 'transaction'` |
   | `PUT /:id`          | `inventory.stock.read`       | response                    |
   | `POST /:id/approve` | `inventory.invoices.approve` | `completion: 'transaction'` |
   | `POST /:id/reject`  | `inventory.invoices.approve` | `completion: 'transaction'` |
   - Lists show invoices at the locations where the person may receive or approve.
   - `PUT` (only while pending) is for an approver or the person who sent it; others get 404.
   - Approve books one receipt through `StockService.importReceipt` with `newItemsApproved` (the approval accepts the
     new items: no separate `inventory.items.edit`). The status changes in the same transaction, only if the invoice
     is still pending and unchanged since it was read; otherwise 409 `inventory.vendor_invoice_decided`.
   - `POST /inventory/receipts/import` (ADR 0049) is removed: every invoice goes through the queue.

3. **New permission** `inventory.invoices.approve` (location scope): admin and manager are granted it; it is its own
   area ("Vendor invoices") in the role editor.
4. **Notified and audited.** Submitting notifies the holders of `inventory.invoices.approve` at the warehouse's
   location (`invoice_submitted`, also by email by default); approving or rejecting notifies the sender
   (`invoice_approved`, `invoice_rejected`). Audit `inventory.vendor_invoice.submitted|updated|approved|rejected`
   with ids, number, status, warehouse, supplier, invoice number, counts, total and receipt; never the note, the
   descriptions or the reason (free text).
5. **Photos and scans, read on the device.** `/inventory/invoice` takes one PDF or several photos (JPG, PNG, WebP). A
   PDF with text is read as before; a PDF without text and photos go through the menu scan's on-device recognition
   (`preparePages`, `recognizePages`), and the recognised pieces are grouped into rows by their vertical centres
   (`linesToRows`) and parsed as before. The invoice is marked `scan`, and the review says to check every line
   against the paper. Nothing but the reviewed lines leaves the device.
6. **The approval queue** `/inventory/invoices`: tabs Pending / Approved / Rejected, cards with supplier, numbers,
   lines (new ones), warehouse, total and sender. Opening one shows the same editor as the import page; approvers
   correct, then Approve (unsaved changes are saved first) or Reject with a reason. Decided invoices are read-only
   and show the goods receipt number or the reason.
7. **Import Data redesign.** A header ("Bring your existing data in", three steps), then one tile per kind with icon,
   description and the formats it takes; the vendor invoice tile leads to `/inventory/invoice` and to the queue.
   Files may be CSV or Excel (`.xlsx`, read on the device with `read-excel-file`, numbers as the text Excel stored;
   the sheet named like the kind, else the first). CSV and Excel go through one table reader (`readTableRows`). No
   AI: the template's columns are the contract.

## Consequences

- Stock from an invoice appears only after approval; the receipt's number is on the approved invoice.
- An organization without anyone holding `inventory.invoices.approve` at a location cannot book invoices there:
  owners always can (all permissions).
- On-device recognition is slower (seconds per page) and less exact than a PDF's text; flagged lines and the total
  check point to what to correct.
- `.xls` (old Excel) and other formats are refused with a clear message: save as `.xlsx` or CSV.
