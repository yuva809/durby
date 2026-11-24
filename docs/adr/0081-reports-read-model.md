# ADR 0081: Reports: one definition per metric, a read model fed by events

- Status: accepted
- Date: 2026-11-24
- Spec: [reports](../modules/reports.md). Builds on [ADR 0013](0013-outbox.md) (outbox),
  [ADR 0016](0016-table-service-before-tse.md) (no payments yet), [ADR 0036](0036-guest-checks-splits-merges-discounts.md)
  (discounts) and [ADR 0069](0069-table-management-placements-moves-merges.md) (moves, merges, transfers).

## Context

The `reports` feature is in the plans with nothing behind it. Owners want sales, busy hours, items, categories, table
times and reservation figures. Reports must not query other modules' tables (rule 4), and a figure must mean the same
on a card, in a table and in an export.

## Decisions

1. **A sale is what was sent**: lines sent from the till minus voids and discounts, at the price they were sent with,
   counted at the time the line was sent. Durby records no payments yet (ADR 0016), and bills miss orders closed without
   one. It is not an accounting revenue figure, and the page says so. A void counts against the time of the line it
   voids, not its own.

2. **Metrics are a registry** (`packages/shared/src/metrics.ts`): key, label, unit, feature and permission. Cards,
   tables and exports read their definition from it; a test requires an api query for every key.

3. **A read model, not a ledger.** `report_order_facts`, `report_line_facts` and `report_reservation_facts` are derived
   and can be rebuilt, so their rows are replaced (rule 7 does not apply to them). They are tenant tables like any other
   (RLS, ADR 0005). They hold no names, notes or guest data. Instants are UTC: changing the time zone or the day's
   start needs no rebuild.

4. **Read ports.** pos and reservations export a reader that answers facts by id (`PosSalesReader`,
   `ReservationsReader`). Reports never reads their tables.

5. **Handlers recompute, they don't add up.** Each event recomputes the whole order (or reservation) from the port and
   replaces its rows, under a transaction-level advisory lock taken before reading. Redelivered, late or reordered
   events therefore end in the same state, and two handlers for one order run one after the other. Organizations without
   `reports` are skipped.

6. **`pos.order.updated`** (v1: order and location id) is a new event for changes that emitted nothing: covers, move,
   the target of a merge, discounts added and removed. An older worker leaves it pending (ADR 0013).

7. **Lines belong to the order they were sent on**, for reports. A merge moves a ticket's placement, not the sale, so
   reading by the original order counts nothing twice. A source whose tickets were all placed elsewhere is marked
   merged away and left out of table times.

8. **A round is a send, not a ticket.** One send writes up to two tickets (kitchen and bar). `pos_kitchen_tickets` gets a
   nullable `send_id` and `transferred` (default false), expand only. Tickets of one order from before that were written
   within two seconds count as one send. A transfer is not a round.

9. **The business day** starts at `reports.dayStartsAt` (default 04:00) in the location's time zone; each location uses
   its own.

10. **Permissions**: `reports.sales.read`, `reports.reservations.read`, both per location. Granted to Admin and Manager
    (Owner holds every key), denied to every other system role. Custom roles don't get them.

11. **Rebuild**: `reports rebuild --org <id> [--from <date>]` recomputes in batches through the same code as the
    handlers, and removes facts whose source is gone. Audited. Needed once per organization after the first release,
    and after switching `reports` on.

12. **CSV is built in the browser** from the loaded report, with translated headers. Text cells that a spreadsheet
    would read as a formula are neutralised.

## Consequences

- Figures follow the till by the outbox's delay, normally about a second.
- An item moved to another table by a transfer is a void and a new line (ADR 0069), so it counts at the time of the
  transfer, and the new order counts as an order. Totals don't change.
- A category's share uses the product's category now, not at the time of sale.
- "Least sold" lists products sold at least once in the period.
- When payments exist, revenue is a new metric; `sales.*` keeps its meaning.
