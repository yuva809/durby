# POS module: table service

Restaurant table service: tables per location (step 1), waiter orders and kitchen tickets (step 3), guest checks
and the billing counter (step 4). Code: `apps/api/src/modules/pos/`. Decisions:
[ADR 0016](../adr/0016-table-service-before-tse.md). Fiscal receipts and payments are **not** part of this module
yet: they need a TSE (`pos.fiscal`, a later step).

## Roadmap

| Step | Delivers                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | Dining tables per location (owner / admin / manager manage them). Catalog: [catalog.md](catalog.md).                        |
| 2    | `waiter` and `cashier` system roles (ADR 0007 amendment).                                                                   |
| 3    | Orders: a waiter picks a table, adds products, confirms → order number + kitchen ticket print view.                         |
| 4    | Guest checks ("Zwischenrechnung", not a receipt): print from the table; billing counter lists open, recent and past checks. |

Step 4 gets its own plan and updates this spec before it is built.

## Step 1: dining tables

```
Organization (tenant)
 └─ Location
     └─ DiningTable   dining_tables   tenant table (RLS)
```

| Table           | Columns                                                                                            | Notes                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dining_tables` | `id`, `tenant_id`, `location_id`, `name`, `seats`, `area`, `sort_order`, `archived_at`, timestamps | `(tenant_id, location_id)` → locations, `RESTRICT`. Name unique per location among non-archived |

- `name`: trimmed 1–50 (e.g. "T1", "Terrace 4"). `seats`: integer 1–100. `area`: optional trimmed 1–50 ("Terrace").
- Archive, never delete: orders and checks (steps 3–4) reference tables.
- Feature: the existing `pos`. Organizations on plans without `pos` get 403 `entitlements.feature_disabled`.

### Permissions

| Key                 | Scope    | Grants                                    | admin | manager | staff |
| ------------------- | -------- | ----------------------------------------- | ----- | ------- | ----- |
| `pos.tables.read`   | location | list a location's tables                  | ✓     | ✓       | ✓     |
| `pos.tables.manage` | location | create, edit, archive a location's tables | ✓     | ✓       |       |

Both are checked **at the table's location**: a location-limited manager manages only their locations' tables.

### API (`/api/v1`, `@RequireFeature('pos')`)

| Method + path           | Permission                                  | Idempotency                 | Body / query                                      |
| ----------------------- | ------------------------------------------- | --------------------------- | ------------------------------------------------- |
| `GET /pos/tables`       | `pos.tables.read` (filters by location)     |                             | `?locationId=&includeArchived=true`               |
| `POST /pos/tables`      | `pos.tables.manage` at `locationId`         | `completion: 'transaction'` | `{ locationId, name, seats, area?, sortOrder? }`  |
| `PATCH /pos/tables/:id` | `pos.tables.manage` at the table's location | response                    | `{ name?, seats?, area?, sortOrder?, archived? }` |

A table can't move to another location (archive it and create a new one). Lists: `sort_order`, name, id.

### Errors

| Code                     | Status | When                                                                             |
| ------------------------ | ------ | -------------------------------------------------------------------------------- |
| `pos.table_not_found`    | 404    | unknown id, another tenant's id, a bad UUID, or a location the caller can't read |
| `pos.location_not_found` | 404    | `locationId` doesn't exist in the organization                                   |
| `pos.table_name_taken`   | 409    | a non-archived table of the location already has this name                       |

Labels: `pos.errors.<camelCase>`.

### Audit

| Action                     | Entity         | Snapshot fields                                                        |
| -------------------------- | -------------- | ---------------------------------------------------------------------- |
| `pos.dining_table.created` | `dining_table` | `id`, `locationId`, `name`, `seats`, `area`, `sortOrder`, `archivedAt` |
| `pos.dining_table.updated` | `dining_table` | same (also archive / unarchive)                                        |

### Web

`/pos/tables` (nav: Modules → Tables, feature `pos`, permission `pos.tables.read`): location picker, list of tables;
create/edit/archive only where the user holds `pos.tables.manage` for the selected location.

## Areas

A location's floor is divided into **areas** ("Dining room", "Terrace", "Bar"). Areas are records of their own
(`dining_areas`): they exist before any table is put in them, can be renamed in one place and are deleted only while
no table uses them (also no table out of service). A table has at most one area, always at its own location.

| Table           | Columns                                                                           | Notes                                                                                        |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `dining_areas`  | `id`, `tenant_id`, `location_id`, `name` (trimmed 1–50), `sort_order`, timestamps | `UNIQUE (tenant_id, location_id, name)`; RLS                                                 |
| `dining_tables` | + `area_id`                                                                       | FK `(tenant_id, location_id, area_id)` → `dining_areas`: the area is at the table's location |

**Expand/contract (ADR 0004).** Areas used to be the free text `dining_tables.area`. The `…_dining_areas` migration
created one area per distinct `(location, area)` text and pointed the tables at it. The text column stays for now and
the api keeps it equal to the area's name (table create/update, area rename), so the previous release still shows
correct areas after a rollback. A later contract migration drops it (docs/plan → Contract migrations).

| Method + path           | Permission                                 | Idempotency                 | Body / query                                        |
| ----------------------- | ------------------------------------------ | --------------------------- | --------------------------------------------------- |
| `GET /pos/areas`        | `pos.tables.read` (filters by location)    |                             | `?locationId=`; each with `tableCount` (in service) |
| `POST /pos/areas`       | `pos.tables.manage` at `locationId`        | `completion: 'transaction'` | `{ locationId, name, sortOrder? }`                  |
| `PATCH /pos/areas/:id`  | `pos.tables.manage` at the area's location | response                    | `{ name?, sortOrder? }`                             |
| `DELETE /pos/areas/:id` | `pos.tables.manage` at the area's location | response                    | 409 `pos.area_not_empty` while tables use it        |

Tables take `areaId` (or `null`) instead of the area text; responses have `areaId` and `area` (the name).
Errors: `pos.area_not_found` (404: unknown, another tenant's, another location's for a table, or a location the
caller can't read), `pos.area_name_taken` (409), `pos.area_not_empty` (409). Audit: `pos.dining_area.created`,
`.updated`, `.deleted` (entity `dining_area`: `id`, `locationId`, `name`, `sortOrder`); `dining_table` snapshots add
`areaId`.

**Web.** Table management is its own page, **`/tables`** (nav "Tables", feature `pos`, `pos.tables.read`), apart from
the POS screens. Area tabs (All, each area in order with its count, also empty ones, and "No area") sit above a
floor-plan grid of table tiles; the selected area's tools are rename and delete (disabled with a hint while it has
tables). Add area sits by the tabs, New table in the header (it preselects the selected area); a tile's ⋯ menu takes
the table out of service or back.

## Read port for other modules

`PosFloorReader` (exported from `pos/index.ts`) is how other modules read pos's floor, never its tables
(CLAUDE.md rule 4; first consumer: reservations, [ADR 0019](../adr/0019-reservations-exclusion-constraint-and-redis-holds.md) §7):

| Method                   | Returns                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `tablesAt(locationId)`   | the location's tables in service, floor order: id, location, name, seats, area id and name, shape, colour, sort order |
| `table(id)`              | one table, archived or not (`archivedAt`), or `null`                                                                  |
| `openOrders(locationId)` | `{ tableId, orderId, openedAt }` per open order, in floor order                                                       |

It reads in the current tenant (RLS) and checks **no permission keys**: callers check their own keys at the location
first. pos never imports its consumers. A composite FK from another module to `(tenant_id, location_id, id)` uses
the unique index `dining_tables (tenant_id, id, location_id)` that pins orders to their table's location.

## Step 3: orders and kitchen tickets

**One open order per table.** A waiter picks a table, builds a cart in the browser and **sends it to the kitchen**:
that writes one kitchen ticket and its lines, opening the table's order (with a number) if it has none. Sending
again adds ticket 2, 3, …. Nothing is edited afterwards: a correction is a **void ticket** whose lines have negative
quantities and point at the voided line (CLAUDE.md rule 7). Closing the order frees the table; step 4 ties closing
to the guest check.

```
Location
 └─ DiningTable
     └─ PosOrder              pos_orders           one with status 'open' per table (partial unique index)
         ├─ PosKitchenTicket  pos_kitchen_tickets  append-only; sequence 1, 2, … per order; kind order | void
         └─ PosOrderLine      pos_order_lines      append-only; snapshot of name, price, VAT rate
```

| Table                 | Columns                                                                                                                                                                                                          | Notes                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pos_orders`          | `id`, `tenant_id`, `location_id`, `table_id`, `number`, `status` (`open`/`closed`), `opened_by_user_id`, `opened_at`, `closed_by_user_id`, `closed_at`, timestamps                                               | `UNIQUE (tenant_id, number)`; partial `UNIQUE (tenant_id, table_id) WHERE status = 'open'`; no DELETE |
| `pos_kitchen_tickets` | `id`, `tenant_id`, `order_id`, `sequence`, `kind` (`order`/`void`), `created_by_user_id`, `created_at`                                                                                                           | `UNIQUE (tenant_id, order_id, sequence)`; no UPDATE/DELETE                                            |
| `pos_order_lines`     | `id`, `tenant_id`, `order_id`, `ticket_id`, `product_id`, `product_name`, `unit_price numeric(12,2)`, `tax_rate numeric(5,2)`, `quantity` (int ≠ 0), `note`, `voids_line_id`, `created_by_user_id`, `created_at` | no UPDATE/DELETE; `quantity < 0` exactly when `voids_line_id` is set                                  |

- **Snapshots.** Name, gross unit price and VAT rate are copied from the product when the line is written; later
  menu edits never change an order. Quantity is a portion count (an integer), not money or stock.
- **Numbers.** Series `pos.order` (feature `pos`, `ORD-{YYYY}-{seq:6}`, yearly), allocated in the transaction that
  opens the order.
- **Totals** (computed, gross): line total = unit price × quantity; the order total and the per-VAT-rate split
  (gross, net = gross / (1 + rate), tax = gross − net, rounded to cents) use `decimal.js`. JSON carries strings.
- **Concurrency.** Ticket writes lock the order row; two first sends to a free table race on the partial unique
  index and the loser retries once, landing on the same order.
- User ids are stored without a foreign key (users are platform rows private to platform/auth) and never returned;
  tickets don't name the waiter.

### Permissions (location scope, checked at the table's location)

| Key                | Grants                                   | admin | manager | staff | waiter | cashier |
| ------------------ | ---------------------------------------- | ----- | ------- | ----- | ------ | ------- |
| `pos.orders.read`  | floor, orders, tickets                   | ✓     | ✓       |       | ✓      | ✓       |
| `pos.orders.take`  | send items to the kitchen (opens orders) | ✓     | ✓       |       | ✓      |         |
| `pos.orders.void`  | void sent items                          | ✓     | ✓       |       |        |         |
| `pos.orders.close` | close an order (frees the table)         | ✓     | ✓       |       | ✓      | ✓       |

A table or order at a location where the caller can't read orders doesn't exist for them (404).

### API (`/api/v1`, `@RequireFeature('pos')`)

| Method + path                       | Permission         | Idempotency                 | Body / query                                                      |
| ----------------------------------- | ------------------ | --------------------------- | ----------------------------------------------------------------- |
| `GET /pos/floor`                    | `pos.orders.read`  |                             | `?locationId=`: non-archived tables with their open order summary |
| `GET /pos/tables/:tableId/order`    | `pos.orders.read`  |                             | the table and its open order (or `null`)                          |
| `POST /pos/tables/:tableId/tickets` | `pos.orders.take`  | `completion: 'transaction'` | `{ lines: [{ productId, quantity 1–99, note? }] }`, 1–100 lines   |
| `GET /pos/orders`                   | `pos.orders.read`  |                             | `?locationId=&status=open\|closed`, newest first, at most 100     |
| `GET /pos/orders/:id`               | `pos.orders.read`  |                             |                                                                   |
| `POST /pos/orders/:id/voids`        | `pos.orders.void`  | `completion: 'transaction'` | `{ lines: [{ lineId, quantity 1–99 }] }`                          |
| `POST /pos/orders/:id/close`        | `pos.orders.close` | response                    | no body; closing a closed order changes nothing                   |

Products must exist, not be archived, and not be in an archived category; the table must not be archived.

### Errors

| Code                      | Status | When                                                              |
| ------------------------- | ------ | ----------------------------------------------------------------- |
| `pos.order_not_found`     | 404    | unknown id, another tenant's, or a location the caller can't read |
| `pos.order_closed`        | 409    | a void on a closed order                                          |
| `pos.product_unavailable` | 409    | unknown or archived product (or category); `details.productIds`   |
| `pos.line_not_found`      | 404    | void of a line that isn't a sent item of this order               |
| `pos.void_exceeds`        | 409    | voiding more than is left of a line                               |

### Audit

| Action                       | Entity           | Snapshot fields                                               |
| ---------------------------- | ---------------- | ------------------------------------------------------------- |
| `pos.order.opened`           | `pos_order`      | `id`, `number`, `tableId`, `locationId`, `status`, `closedAt` |
| `pos.order.closed`           | `pos_order`      | same                                                          |
| `pos.kitchen_ticket.created` | `kitchen_ticket` | `id`, `orderId`, `sequence`, `kind`, `lineCount`              |

Notes are free text and stay out of snapshots.

### Events

| Type               | Version | Payload                            | Written when                                                        |
| ------------------ | ------- | ---------------------------------- | ------------------------------------------------------------------- |
| `pos.order.closed` | 1       | `{ orderId, locationId, tableId }` | `POST /pos/orders/:id/close` closes an open order (not on a repeat) |

Written in the close's transaction (ADR 0013), ids only. First consumer: reservations finishes the seated booking on
that table ([reservations.md](reservations.md), ADR 0019 §7). Sends and voids write no events yet; a kitchen display
would add them.

### Web

- `/service` (nav "Service", `pos.orders.read`; the "POS" menu entry stays the official POS module): the **floor**, a grid of the location's tables: free, or open with order
  number, item count and total. A table opens the order screen.
- `/service/[tableId]`: menu by category, cart (quantity, note), **Send to kitchen** → the kitchen ticket print
  view (`window.print()`); the order so far with voided items struck through, totals, **Reprint** per ticket,
  **Void** (with `pos.orders.void`), **Close order** (with `pos.orders.close`).
- **Printing.** Holders of `pos.bills.print` (waiter, cashier, manager, admin, owner) print the **bill** with
  prices, VAT and total, marked "not a receipt". A role without it (a custom role) prints the **order slip**: table,
  order number, time, the order's items (combined) with quantities and notes, item count; no prices, VAT or totals.
  Waiters got `pos.bills.print` on 2026-10-29 (ADR 0016 §8 note): they bill and check out like the cashier. For now the key gates the web
  print; step 4's guest-check endpoints will require it in the api.
- Kitchen ticket: table, order number, ticket number, time, items with quantity and note; no prices; "VOID" for void
  tickets. Printed through a print-only element (`#print-root`); everything else is hidden in print.
