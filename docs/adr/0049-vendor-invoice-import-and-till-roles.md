# ADR 0049: Vendor invoice import (PDF) and till roles only with the till

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0027 (receipts), ADR 0044 (Import Data), ADR 0045 (roles per feature), ADR 0048 (item categories)

## Context

A distributor (the operations menu's partner) gets its stock as supplier invoices and order confirmations in PDF
(e.g. Bonesca order 108666: 24 lines, € 5,739.80). Import Data took only CSV, so the PDF could not even be chosen, and
every receipt was typed in by hand. The same organization saw the restaurant roles (waiter, cashier, kitchen, bar,
host) in its role pickers although it has no till.

## Decisions

1. **Till roles follow the till.** `SYSTEM_ROLE_FEATURES` now also maps waiter, cashier, kitchen and bar to `pos` and
   host to `reservations`, beside the branch roles' `orders` (ADR 0045). The roles list leaves them out where the
   feature is off; members who hold one keep it.
2. **The PDF is read in the browser, not uploaded.** `pdfjs-dist` (already used by the menu scan) gives the text with
   positions. Pieces within 3 points of the same baseline form a row, read left to right. A row is an item line when it
   ends in quantity, unit price, optional VAT % and total, with an optional supplier code (with a digit) and the
   description in front. Amounts are read in either notation ("1.245,00", "1,245.00"). Each line is checked:
   quantity × price must be its total within a cent.
   - The order number comes from a number label ("Order number", "Invoice no.", "Rechnungsnummer" …) and the first
     dd-mm-yyyy date is taken as the date. The supplier is guessed from the footer e-mail domain (not webmail).
   - The grand total is the last "Total" row that isn't net, excluding VAT or a weight.
   - A PDF without text (a scan) is refused with a clear message. More than 20 pages is refused too.
3. **Review before booking.**
   - Lines are matched to stock items by SKU = the supplier's code first, then the exact name (ignoring case and
     spacing). Archived items and parents with variants are never matched; an unmatched line is New.
   - Per line the person can change the item, quantity and cost, or leave the line out. New items share one unit
     (default piece = one carton as invoiced) and an optional category.
   - The page compares the receipt total with the invoice total.
   - Import is blocked for bad amounts, an item on two lines, or New lines for someone without
     `inventory.items.edit`.
4. **One request, one transaction.** `POST /api/v1/inventory/receipts/import` (`inventory.stock.receive` at the
   warehouse; new items also `inventory.items.edit`) creates the new items (audited, name not taken by an active item,
   SKU = supplier code, category active) and books one receipt with supplier and note, completing its idempotency key in
   the same transaction. Any failure leaves nothing behind.
5. **Where.** "Import Vendor Invoice" on the operations Inventory page, and a card on Import Data; route
   `/inventory/invoice`.

## Consequences

- Only the confirmed receipt reaches the server; the PDF never does.
- Invoices laid out differently (columns in another order, quantities after prices) may read no lines; the message
  points to manual receipt entry. Adding a layout is a parser change with a test of its rows.
- Units of measurement per line (e.g. "10 x 1kg" as 10 kg) are not derived from the description; the line's quantity is
  taken in the item's unit as invoiced.
