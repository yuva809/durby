# ADR 0062: Best-before dates per warehouse, more units, and an invoice import without costs

- Status: accepted (2026-11-19)
- Date: 2026-11-19
- Builds on: ADR 0027 (stock and valuation), ADR 0049 / 0054 / 0058 (vendor invoices), ADR 0055 (units, pack size)

## Context

The distributor sells food: what a branch gets should say until when it is good. Stock had no dates. Its suppliers
sell in boxes, buckets, bags and packets, which the unit list (kg, g, l, ml, pc) didn't have. And the people who
import invoices only check what arrived: the unit cost and value columns were noise for them.

## Decisions

1. **More units**: `box`, `bucket`, `bag`, `packet` join `stock_unit` (expand only: values are only added). `pc` is
   the piece (Stück). Stock is still counted in the item's own unit.
2. **Best before, the earliest per warehouse** (not batches): a receipt line, an import receipt line and a vendor
   invoice line can carry `expiresOn` ("2027-03-31"). `stock_levels.expires_on` keeps the earliest date of what is in
   stock: goods coming in make it the earlier of the level's (while it holds any) and theirs; goods without a date
   leave it as it is; goods going out carry it along (transfers, packing and receiving branch requests) and when
   nothing is left it goes. `stock_movements.expires_on` records the date goods came or went along with;
   `vendor_invoice_lines.expires_on` keeps it as printed until approval books it. Expand only: nullable columns,
   nothing backfilled.
3. **The api answers it**: stock levels (`expiresOn`, null without stock), document lines, vendor invoice lines and
   the request cart's availability (the main warehouse's date).
4. **The pages**: the invoice import has a Best before date per line and no longer shows Unit cost and Value (still
   read from the invoice, saved and checked against its total; shown again on a line whose cost needs fixing;
   approvers see them in the queue). The receipt form has Best before per line; the stock tab and the inventory
   overview show it (the earliest across the warehouses shown), red once past.

## Consequences

- It is the earliest date, not a batch: after part of a delivery is sold the date stays the earliest one until the
  stock runs out. Batch tracking (each delivery with its own quantity, first-expiry-first) would be a later step.
- Stock received before has no date until its next delivery with one.
