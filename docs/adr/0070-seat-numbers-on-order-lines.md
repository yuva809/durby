# ADR 0070: Seat numbers on order lines

- Status: accepted
- Date: 2026-11-20
- Step: order taking, first row of the tracker group "L3 FOH Service & POS → Order taking" ("Seat numbers").
  Builds on [ADR 0016](0016-table-service-before-tse.md) (orders, tickets), [ADR 0036](0036-guest-checks-splits-merges-discounts.md)
  (bills of selected items) and [ADR 0069](0069-table-management-placements-moves-merges.md) (lines follow their ticket).

## Context

A waiter takes an order for a table with several guests and needs to say which guest ordered which item, so the bill
can be split by seat. Today a line only knows its product and quantity; an order has a covers count, but no item is
tied to a seat.

## Decisions

1. **A seat is a number on the line.** `pos_order_lines.seat` is an optional integer 1–20, set when the line is sent.
   No seat table: the number is the guest's place at the table for this order only.
2. **Seats are fixed at send time (ADR 0016: tickets are append-only).** A line's seat never changes. To move an item to
   another seat the waiter voids it and sends it again, as with any correction.
3. **A void copies its line's seat**, so the seat's lines net to what is still ordered for it.
4. **A transfer (ADR 0069, step 6) copies the seat to the new order's sale line.** A merge keeps lines as they are.
5. **Bills stay as they are.** "Bill seat 2" is a bill of the unbilled lines whose seat is 2, sent through the existing
   bill route with the line ids. The split-by-items rules (ADR 0036) apply unchanged.
6. **No seat means no seat**: an item sent without a seat is billed with "all" or by item, as before.

## Consequences

- An expand-only migration adds a nullable column with a CHECK (1–20). Existing lines have no seat.
- The order response gains `seat` on every line (null for old lines and unseated items).
- Seat numbers are not limited by the covers count, because covers can be unset or changed later.
