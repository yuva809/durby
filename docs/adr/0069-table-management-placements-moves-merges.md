# ADR 0069: Table management: placements, moves, merges and transfers

- Status: accepted
- Date: 2026-11-20
- Step: table service step 5 (tracker group "L3 FOH Service & POS → Table management"). Builds on
  [ADR 0016](0016-table-service-before-tse.md) (orders, tickets, one open order per table),
  [ADR 0025](0025-bill-layout-and-stations.md) (stations), [ADR 0036](0036-guest-checks-splits-merges-discounts.md)
  (bills take items of several orders).

## Context

A waiter needs four things the table service does not do yet:

- see how long a table has been seated and how long since its last order;
- move a whole open order to a free table;
- merge two open orders into one, with the lines keeping their tickets;
- move selected items to another table or to a new order.

The order belongs to its table, and the one-open-order-per-table rule is a partial unique index on
`pos_orders(table_id)`. Tickets (`pos_kitchen_tickets.order_id`) and lines (`pos_order_lines.order_id`) are
append-only, and a composite foreign key forces a line's order to equal its ticket's order. Bills and discounts
reference the same links (ADR 0036). So an item cannot change order by rewriting its rows.

## Decisions

1. **Placement rows.** `pos_ticket_placements` is an append-only table that records which order a ticket belongs to
   now. Every ticket gets one row when it is written, so the latest row always exists. A line belongs to the order of
   its ticket's current placement. Moving or merging writes a new placement row; tickets and lines are never rewritten.
   Reads that load an order's tickets and lines resolve through the latest placement. Bills and discounts keep the
   order they were made on.

2. **Move order.** `POST /pos/orders/:id/move {tableId}` changes only the order's table. The target must be a
   non-archived table with no open order at the same location. No ticket is written, so the kitchen is not reprinted.
   Audited as `pos.order.moved`. Permission `pos.orders.take`.

3. **Merge.** `POST /pos/orders/:id/merge {orderId}` moves the source order's tickets to the target order (one
   placement row per ticket), then closes the source with `pos.order.merged`. Its table is released through the existing
   `pos.order.closed` event. Both orders must be open and at the same location. Billed lines block the merge.
   The target keeps its number.

4. **Split and transfer.** `POST /pos/orders/:id/transfer` moves chosen portions to another table or a new order. The
   source gets a void ticket for the portions (negative lines, as a void does), and the destination gets a sale ticket
   with the same product and price snapshot. Both are normal tickets, so the audit trail and kitchen history stay whole.
   **Amended while building step 6:** a new order needs a table of its own (one open order per table, ADR 0016), and the
   source keeps its table, so the destination is always a free table at the same location, where a new order opens with
   its own number. Transfers to an open order are not offered (that is a merge).
   Only unbilled portions can move. Audited as `pos.order.transferred`.

5. **Timer.** The floor summary carries `seatedAt` (the order's `openedAt`) and `lastOrderAt` (the newest ticket's
   creation time). The tile shows both in minutes and refreshes with the floor's existing refresh. Display only.

6. **No kitchen reprint** on move or merge. Placements are not print events and do not touch the print queue.

7. **Expand only.** The placement table is new and is backfilled with one row per existing ticket, in the same
   migration. Nothing is dropped or renamed.

## Consequences

- Every order read that lists tickets or lines goes through the placement table. A missed read would show a moved
  item on the wrong order, so each order read is covered by a test.
- A move changes the order's table only. Its number stays the same, and numbers are never reused.
- Merging two orders with billed lines is refused. A bill is first cancelled or left as it is.
- Transfer creates two tickets per move, so the ticket log shows both sides of the move.
