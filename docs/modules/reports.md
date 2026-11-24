# Module: reports

Feature `reports`; sales and tables also need `pos`, reservations need `reservations`. Decisions:
[ADR 0081](../adr/0081-reports-read-model.md). Read only: no route writes.

## Metrics (`packages/shared/src/metrics.ts`)

| Key                        | Unit    | Definition                                                                              |
| -------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `sales.gross`              | money   | Σ net quantity × unit price − discounts of lines sent in the period                     |
| `sales.items`              | count   | Σ net quantity (after voids)                                                            |
| `sales.orders`             | count   | Orders with at least one line left, by the time of their first such line                |
| `sales.averageOrder`       | money   | `sales.gross` ÷ `sales.orders`; none without orders                                     |
| `sales.secondRoundRate`    | percent | Orders with two or more rounds ÷ `sales.orders`                                         |
| `tables.averageMinutes`    | minutes | Average closed − opened, orders closed in the period, without those merged away         |
| `tables.open`              | count   | Open orders now                                                                         |
| `reservations.covers`      | count   | Σ party size of seated and finished bookings (walk-ins included)                        |
| `reservations.noShowRate`  | percent | No-shows ÷ (no-shows + seated + finished), without walk-ins; cancelled and declined out |
| `reservations.turnMinutes` | minutes | Average finished − seated of finished bookings                                          |

Net quantity = sent quantity plus its void lines (negative). A round = a distinct send of the order with a line left;
transfers are not rounds. Reservation figures go by the booking's start.

Breakdowns of `sales.gross` / `sales.items`: by hour of day, by product (top and least sold), by category (share of
gross). Table times also per table.

## Periods

Business days `from`–`to`, at most 366. A day runs from `reports.dayStartsAt` to the next day's, in the location's
time zone; across locations each uses its own. On the switch days a day is 23 or 25 hours long. Hours are wall-clock
hours, so the repeated hour in autumn counts as one.

Cards: today so far against the same weekday last week up to the same wall-clock time; yesterday against the same
weekday the week before; this week (from Monday) so far against last week's same span. A difference in percent is shown
only when the comparison is not zero.

## Fact tables

`report_order_facts` (one per order), `report_line_facts` (one per sent line), `report_reservation_facts` (one per
booking). Derived, replaceable, tenant tables with RLS. No names, notes, guest data or user ids.

## Events

| Event                                                                         | Effect                |
| ----------------------------------------------------------------------------- | --------------------- |
| `pos.order.opened`, `.closed`, `.updated` (new), `pos.kitchen_ticket.created` | recompute the order   |
| `reservations.reservation.created`, `.updated`, `.status_changed`             | recompute the booking |

## Routes (`/api/v1/reports`)

| Route                                                                     | Key                         | Feature                   |
| ------------------------------------------------------------------------- | --------------------------- | ------------------------- |
| `GET /sales/summary`, `/sales/hours`, `/sales/items`, `/sales/categories` | `reports.sales.read`        | `reports`, `pos`          |
| `GET /tables`                                                             | `reports.sales.read`        | `reports`, `pos`          |
| `GET /reservations`                                                       | `reports.reservations.read` | `reports`, `reservations` |

`locationId` is optional; without it, all locations the caller holds the key at. A location the caller can't read
answers 404, like an unknown one.

## Rebuild

`node dist/cli/reports.js rebuild --org <id> [--from YYYY-MM-DD]`: batches of 200, each in its own transaction. Safe
while the till is in use.

## Tests

Each figure against hand-computed numbers (send, void, transfer, merge, discount on and off); events redelivered, out
of order and concurrent; rebuild equals projection; day bounds over both time switches; location limits, denied roles,
features off; cross-tenant isolation on every table.
