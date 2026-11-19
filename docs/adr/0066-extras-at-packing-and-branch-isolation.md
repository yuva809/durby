# ADR 0066: The warehouse may send extra; a branch sees only its own requests

- Status: accepted (2026-11-19)
- Date: 2026-11-19
- Builds on: ADR 0045 (branch requests), ADR 0053 (main warehouse), ADR 0057 (branch and warehouse access),
  ADR 0059 (the branch's view)

## Context

A branch asks for 5 apples and 4 other products; the warehouse sometimes sends 6 apples, and products the branch
didn't ask for. Packing was capped at the approved quantity, and only requested items could be sent.

A branch must not see another branch's requests. The list showed a member the requests of every location where they
read requests, as a branch **or as the source**. A branch manager at the same location as the main warehouse (a shop
in the same building) therefore saw every branch's requests. A branch member saved with no branch ticked reads every
branch.

## Decisions

1. **More than approved.** Pack accepts any picked quantity per line. Stock still can't go below zero unless the
   location allows it.
2. **Extra products at packing.** Pack takes `extra[]` (item, quantity). For an item on a line that was dropped at
   approval, the extra becomes that line's picked quantity. Otherwise it becomes a new line with
   `added_at_packing = true`, the quantity is what was packed and the approved quantity is 0. An item on a line
   still to send is refused (raise that line instead). The request panel marks such lines "Extra" with no requested
   quantity. The Delivery Challan lists them, and the Order Confirmation (what was ordered) leaves them out.
3. **Who sees a request.** A branch sees the requests **into** its locations (`orders.requests.read` there). Only
   those who work the source (`orders.picking.use` or `orders.delivery.assign` there) see the requests **out of**
   it. Approvers see all.
4. **A branch member needs a branch.** In the operations menu, someone who sends requests and doesn't approve them
   can't be saved without a branch ticked.

## Consequences

- `stock_request_lines.added_at_packing` (expand-only, default false); `addedAtPacking` on request lines (defaults
  to false for older apis).
- A role that only reads requests at the source (none of the system roles) no longer sees them.
- Members saved earlier with no branch keep seeing every branch until their branch is ticked.
