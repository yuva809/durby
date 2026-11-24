# Module: reports

Feature `reports`; sales and tables also need `pos`, reservations need `reservations`. Decisions:
[ADR 0081](../adr/0081-reports-read-model.md), [ADR 0082](../adr/0082-owner-overview.md),
[ADR 0083](../adr/0083-daily-sales-report-push.md). Read only: no route writes.

## Metrics (`packages/shared/src/metrics.ts`)

| Key                        | Unit    | Definition                                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `sales.gross`              | money   | Σ net quantity × unit price − discounts of lines sent in the period                         |
| `sales.items`              | count   | Σ net quantity (after voids)                                                                |
| `sales.orders`             | count   | Orders with at least one line left, by the time of their first such line                    |
| `sales.averageOrder`       | money   | `sales.gross` ÷ `sales.orders`; none without orders                                         |
| `sales.secondRoundRate`    | percent | Orders with two or more rounds ÷ `sales.orders`                                             |
| `sales.normalDay`          | money   | Average `sales.gross` of the 4 same weekdays before yesterday, days without orders left out |
| `sales.vsNormalDay`        | percent | Yesterday's `sales.gross` against the normal day; none without one or when it is zero       |
| `tables.averageMinutes`    | minutes | Average closed − opened, orders closed in the period, without those merged away             |
| `tables.open`              | count   | Open orders now                                                                             |
| `reservations.covers`      | count   | Σ party size of seated and finished bookings (walk-ins included)                            |
| `reservations.noShowRate`  | percent | No-shows ÷ (no-shows + seated + finished), without walk-ins; cancelled and declined out     |
| `reservations.turnMinutes` | minutes | Average finished − seated of finished bookings                                              |

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

## Overview

The home page `/` for holders of `reports.sales.read` (features `reports`, `pos`); the redirects for branches, drivers
and `startPage` come first. Active locations the caller may read, without warehouse sites, by name; one without sales is
listed with zeros.

- **Today**: sales, orders, average order, open tables now; change against the same weekday last week up to the same
  wall-clock time.
- **Yesterday**: the location's last whole business day, its normal day (above), the difference in money and percent,
  and from how many days the normal day is (1–4). No such day: "No comparison yet".
- **Total**: sums. Its normal day is the sum over the locations that have one, compared with the same locations'
  yesterday; `leftOut` says how many have none.
- Amounts are rounded per location first, so the total is the sum of what is listed.
- `hasData` is false while these locations have no facts at all: the screen then says that earlier orders appear once
  the report data is built.
- Refreshed every 60 s while visible. When a refresh fails for a temporary reason, the last figures stay with their
  time and a notice.

## Daily report

Every morning the active owners of an organization with `reports` and `pos` get a `daily_sales` notification (bell, and push
on devices turned on): yesterday's sales, orders, average order, the change against a normal day (as on the Overview,
with how many locations are left out) and, with several locations, the best one. Tapping it opens the Overview.

- Day: yesterday in the organization's zone; each location's business day of that date.
- Due at `reports.dailyReportAt` (default 08:00) or when that day has ended at every active location, whichever is later;
  for 12 hours, then skipped. No orders that day: nothing is sent.
- `report_daily_messages`: one row per organization and day sent, written with the notifications.
- The worker looks every 5 minutes. `node dist/cli/reports.js daily --org <id>` sends it now, if the day has ended and it
  was not sent yet.

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
| `GET /overview` (no parameters)                                           | `reports.sales.read`        | `reports`, `pos`          |
| `GET /tables`                                                             | `reports.sales.read`        | `reports`, `pos`          |
| `GET /reservations`                                                       | `reports.reservations.read` | `reports`, `reservations` |

`locationId` is optional; without it, all locations the caller holds the key at. A location the caller can't read
answers 404 (`reports.location_not_found`), like an unknown one.

## Web

`/reports` (sales), `/reports/tables`, `/reports/reservations`: tabs, each shown with its key and module. The period and
location are in the address. Every table exports CSV, built in the browser. `/` is the overview.

## Rebuild

`node dist/cli/reports.js rebuild --org <id> [--from YYYY-MM-DD]`: batches of 100, each in its own transaction. Safe
while the till is in use.

## Tests

Each figure against hand-computed numbers (send, void, transfer, merge, discount on and off); events redelivered, out
of order and concurrent; rebuild equals projection; day bounds over both time switches; location limits, denied roles,
features off; cross-tenant isolation on every table.
