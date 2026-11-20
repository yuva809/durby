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

Step 4 is built in parts (below, [ADR 0036](../adr/0036-guest-checks-splits-merges-discounts.md)): 4a guest checks
and the billing counter, 4b discounts and comps, 4c split by item, 4d split equally, 4e merge. Tips wait for
payments (the fiscal module).

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
again adds ticket 2, 3, …. Nothing is edited afterwards: a correction is a **void ticket** (shown to users as "Cancelled") whose lines have negative
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
| `pos_orders`          | `id`, `tenant_id`, `location_id`, `table_id`, `number`, `status` (`open`/`closed`), `covers` (int 1–100, nullable), `opened_by_user_id`, `opened_at`, `closed_by_user_id`, `closed_at`, timestamps               | `UNIQUE (tenant_id, number)`; partial `UNIQUE (tenant_id, table_id) WHERE status = 'open'`; no DELETE |
| `pos_kitchen_tickets` | `id`, `tenant_id`, `order_id`, `sequence`, `kind` (`order`/`void`), `station` (`kitchen`/`bar`), `created_by_user_id`, `created_at`                                                                              | `UNIQUE (tenant_id, order_id, sequence)`; no UPDATE/DELETE                                            |
| `pos_order_lines`     | `id`, `tenant_id`, `order_id`, `ticket_id`, `product_id`, `product_name`, `unit_price numeric(12,2)`, `tax_rate numeric(5,2)`, `quantity` (int ≠ 0), `note`, `voids_line_id`, `created_by_user_id`, `created_at` | no UPDATE/DELETE; `quantity < 0` exactly when `voids_line_id` is set                                  |

- **Snapshots.** Name, gross unit price and VAT rate are copied from the product when the line is written; later
  menu edits never change an order. Quantity is a portion count (an integer), not money or stock.
- **Covers** (guests at the table, `covers`, 1–100 or `null`): optional `covers` on a send counts only when that
  send opens the order. On a table with an open order it is ignored (no error): another till may still hold a value
  from before the table was opened. Changes go through `PATCH /pos/orders/:id` only, which sets or clears them; a
  change writes `pos.order.updated`, the same value writes nothing. The till's "Guests" field sends them with the
  first items, or saves a change on an open order. Reservations will pre-fill them from the seated booking (web only,
  R1.9).
- **Numbers.** Series `pos.order` (feature `pos`, `ORD-{YYYY}-{seq:6}`, yearly), allocated in the transaction that
  opens the order.
- **Totals** (computed, gross): line total = unit price × quantity; the order total and the per-VAT-rate split
  (gross, net = gross / (1 + rate), tax = gross − net, rounded to cents) use `decimal.js`. JSON carries strings.
- **Concurrency.** Ticket writes lock the order row; two first sends to a free table race on the partial unique
  index and the loser retries once, landing on the same order.
- User ids are stored without a foreign key (users are platform rows private to platform/auth) and never returned;
  tickets don't name the waiter. The order carries `waiterName` (ADR 0025): the display name of the member who
  opened it (null when it has none; the bill then leaves the line out), read through the platform port `MemberNames`, for the bill.
- **Stations** (ADR 0025). A category's `station` (`kitchen` or `bar`, catalog) decides where its items go. A send
  writes **one ticket per station** it has lines for, kitchen first, with consecutive sequence numbers, in one
  transaction; a void splits the same way by the station of the ticket that sent each voided line. The ticket's
  `station` is a snapshot. The send and void responses carry `ticketIds` (all of them, in sequence order) and
  `ticketId` (the first, kept for older clients).

### Permissions (location scope, checked at the table's location)

| Key                | Grants                                   | admin | manager | staff | waiter | cashier |
| ------------------ | ---------------------------------------- | ----- | ------- | ----- | ------ | ------- |
| `pos.orders.read`  | floor, orders, tickets                   | ✓     | ✓       |       | ✓      | ✓       |
| `pos.orders.take`  | send items to the kitchen (opens orders) | ✓     | ✓       |       | ✓      |         |
| `pos.orders.void`  | void sent items                          | ✓     | ✓       |       |        |         |
| `pos.orders.close` | close an order (frees the table)         | ✓     | ✓       |       | ✓      | ✓       |

A table or order at a location where the caller can't read orders doesn't exist for them (404).

### API (`/api/v1`, `@RequireFeature('pos')`)

| Method + path                       | Permission         | Idempotency                 | Body / query                                                                                                                                          |
| ----------------------------------- | ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /pos/floor`                    | `pos.orders.read`  |                             | `?locationId=`: non-archived tables with their open order summary                                                                                     |
| `GET /pos/stream`                   | `pos.orders.read`  |                             | `?locationId=`: server-sent events, topic `pos.floor` (orders opened/closed, tickets sent) for `/service` (RT.1, ADR 0044, docs/platform/realtime.md) |
| `GET /pos/tables/:tableId/order`    | `pos.orders.read`  |                             | the table and its open order (or `null`)                                                                                                              |
| `POST /pos/tables/:tableId/tickets` | `pos.orders.take`  | `completion: 'transaction'` | `{ lines: [{ productId, quantity 1–99, note? }] }`, 1–100 lines                                                                                       |
| `GET /pos/orders`                   | `pos.orders.read`  |                             | `?locationId=&status=open\|closed`, newest first, at most 100                                                                                         |
| `GET /pos/orders/:id`               | `pos.orders.read`  |                             |                                                                                                                                                       |
| `POST /pos/orders/:id/voids`        | `pos.orders.void`  | `completion: 'transaction'` | `{ lines: [{ lineId, quantity 1–99 }] }`                                                                                                              |
| `PATCH /pos/orders/:id`             | `pos.orders.take`  | response                    | `{ covers: 1–100 \| null }` on an open order (else 409)                                                                                               |
| `POST /pos/orders/:id/close`        | `pos.orders.close` | response                    | no body; closing a closed order changes nothing                                                                                                       |

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

| Action                       | Entity           | Snapshot fields                                                         |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `pos.order.opened`           | `pos_order`      | `id`, `number`, `tableId`, `locationId`, `status`, `covers`, `closedAt` |
| `pos.order.updated`          | `pos_order`      | same (covers changed)                                                   |
| `pos.order.closed`           | `pos_order`      | same                                                                    |
| `pos.kitchen_ticket.created` | `kitchen_ticket` | `id`, `orderId`, `sequence`, `kind`, `lineCount`                        |

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
  **Cancel items** (a void, with `pos.orders.void`), **Close order** (with `pos.orders.close`).
- **Printing.** Holders of `pos.bills.print` (waiter, cashier, manager, admin, owner) print the **bill**, laid out
  like a till receipt in three parts (ADR 0025):
  - **Header**, from the setting `pos.billHeader` at the order's location: logo, name (else the organization's
    name), phone, email, website; empty fields are left out.
  - **Middle**, the same for everyone: waiter, "Table n · Guests g" (guests when recorded), the bill number (the
    order number), each item as "quantity × name" with its line total (notes below), the TOTAL.
  - **Footer**: the lines of `pos.billFooter` (else "Thank you for visiting!"), the notice "Interim bill – not a
    fiscal receipt" / "Zwischenrechnung – kein Kassenbeleg" (`pos.bill.interimNotice`), "Powered by" the theme's
    product name, and the print date and time. The notice is fixed until the fiscal/TSE module exists: it is printed
    on every bill whatever `pos.billFooter` says, and organizations can't override its label (it is in
    `NEVER_ORG_OVERRIDABLE`); the fiscal module replaces it with the TSE data.

  **No VAT breakdown and no TSE data** (decision 2026-11-02; the till's own screen still shows VAT per rate). A
  role without it (a custom role) prints the **order slip**: table,
  order number, time, the order's items (combined) with quantities and notes, item count; no prices, VAT or totals.
  Waiters got `pos.bills.print` on 2026-10-29 (ADR 0016 §8 note): they bill and check out like the cashier. It gates the web print and,
  since step 4, the guest-check endpoints.

- **Paper:** everything printed from the till (bill, order slip, kitchen ticket) is laid out for an **80 mm
  thermal roll**: `@page { size: 80mm 297mm; margin: 0 }` (the drivers' "roll paper 80 x 297 mm", cut after the
  content), 72 mm printed width, black on white, monospace (`app/globals.css`). Zero margins leave no room for the
  browser's header and footer; while printing, the document title is the organization's name (`lib/pos/print.ts`).
  The organization's name heads every slip; only the bill's footer names the product ("Powered by", ADR 0025).
- Kitchen ticket, laid out like a kitchen printer's slip: "Dine in" (a bar ticket: "BAR"); the organization and time; the table in large
  type; "# order number · Ticket n"; a dashed rule; "New" (or "CANCELLED" in large letters); then each item as quantity
  and name in large type with its note under it. No prices, and it doesn't name the waiter (ADR 0016). Printed
  through a print-only element (`#print-root`); everything else is hidden in print. A send with kitchen and bar
  items prints **one print job per ticket**, kitchen first, the next once the previous print dialog closes
  (`afterprint`), so each can go to its own printer. The ticket log shows each ticket's station.

### Bill layout

- Settings (ADR 0010, organization or location scope, `platform.settings.manage`):
  - `pos.billHeader` `{ logo, name, phone, email, website }`, each `null` or text (name ≤ 100, phone ≤ 40, email
    ≤ 120, website ≤ 120); `logo` a `data:image/png|jpeg|webp;base64,…` URL of at most 200 000 characters. Default:
    all `null`.
  - `pos.billFooter` `{ lines }`, 0–4 lines of 1–64 characters. Default: none (the label `pos.bill.thanks`).
- `GET /pos/bill-layout?locationId=` (`pos.bills.print` at that location, `@RequireFeature('pos')`) → `{ header,
footer }`, the effective values there. An unknown or unreadable location → 404 `pos.location_not_found`.
- Web: Settings → **Bill** edits both for the organization or one location, with a preview of the real bill. The
  logo is shrunk in the browser to at most 384 × 192 px, grayscale, before it is saved.

### Text size

- Settings, same scopes and key as the bill layout:
  - `pos.billText` `{ size, header, items, total, footer }`: `size` one of `small` (×0.85), `normal` (×1), `large`
    (×1.2), `xlarge` (×1.45); each part `null` (as `size`) or its own size. Default: `normal`, no part sizes.
  - `pos.ticketText` `{ size, items }`: kitchen and bar tickets, the item lines optionally their own size. Default
    `normal`.
- `GET /pos/bill-layout` also returns them (`text`, `ticketText`); the web reads them with defaults from an older api.
- Every print path draws the same receipt and ticket (browser print, and the Android app's and LAN printers' raster
  images), so the sizes apply to bills, guest checks, reprints and tickets alike. The type inside is in `em`, scaled
  per part; the paper width stays 72 mm, so larger text wraps sooner.
- Web: Settings → **Bill** → Text size: four buttons for the overall bill and ticket size, a "Same as overall" or size
  choice per part, and the previews show the result before saving. Saved and reset together with header and footer.

## Step 4: billing & checkout (ADR 0036)

A **bill** is one act of billing: items of 1–10 open orders at one location (more than one is a merge). What it
prints is a **guest check**, numbered and reprinted with the same number. Still no payment and no receipt
(ADR 0016 §3): every check carries the "Interim bill – not a fiscal receipt" notice.

```
PosBill                    pos_bills                 single | equal (share_count 2–20)
 ├─ PosBillOrder           pos_bill_orders           the orders it covers
 ├─ PosBillItem            pos_bill_items            billed portions of order lines (snapshot name, price, rate)
 ├─ PosBillDiscount        pos_bill_discounts        order discounts it takes in, per VAT rate
 ├─ PosGuestCheck          pos_guest_checks          numbered CHK-{YYYY}-{seq:6}; one, or one per share
 │   └─ PosGuestCheckShare pos_guest_check_shares    a share's gross per VAT rate
 └─ PosBillCancellation    pos_bill_cancellations    at most one; frees the items
PosOrderDiscount           pos_order_discounts       line or whole order; percent | amount; reason; voids_discount_id
 └─ PosOrderDiscountPart   pos_order_discount_parts  amount per VAT rate
```

All of these are append-only (no UPDATE/DELETE for `durby_app`, statement triggers) tenant tables with RLS.

- **Billed quantity** of an order line = its portions on bills that are not cancelled; never more than the line's net
  quantity (after voids). Bills, voids and discounts lock the order row(s), in id order.
- **Voids** take only unbilled portions (`409 pos.line_billed`: cancel the bill first).
- **Number series** `pos.guestCheck` (feature `pos`, `CHK-{YYYY}-{seq:6}`, yearly), allocated last in the bill's
  transaction, one per check.
- **Totals** of a bill: its items plus its discount rows, through `orderTotals` (gross per VAT rate). A share check's
  gross per rate is the bill's divided by n in cents, the remainder cents on the first shares (4d).
- **Discounts** (4b): a line or the whole order, `percent` (0 < v ≤ 100) or `amount` (0 < v ≤ what is left), with a
  reason (1–40 characters). A comp is a 100 % line discount. The amount is fixed when given, from unbilled items: a
  line discount on the line's unbilled gross at its rate, a whole-order discount spread over the rates pro rata
  (leftover cent on the largest rate). Only unbilled items take discounts; a discounted line is billed whole; a
  whole-order discount goes only onto a bill that takes everything unbilled (`409 pos.discount_needs_full_bill`).
  Removing one writes a counter-row.
- **Closing** an order stays separate from billing (no payments yet).

### Permissions (location scope)

| Key                   | Grants                                       | admin | manager | waiter | cashier | others |
| --------------------- | -------------------------------------------- | ----- | ------- | ------ | ------- | ------ |
| `pos.bills.print`     | bill, list and reprint checks (existing key) | ✓     | ✓       | ✓      | ✓       |        |
| `pos.bills.cancel`    | cancel a bill                                | ✓     | ✓       |        |         |        |
| `pos.orders.discount` | give or remove a discount or comp            | ✓     | ✓       |        |         |        |

The owner holds every key. A bill's orders must be readable (`pos.orders.read`) at their location, else 404.

### Setting

`pos.discountReasons` `{ reasons }`: 0–20 reasons of 1–40 characters, organization or location scope, default none.
With none, the till offers the built-in reasons (labels `pos.discount.reasons.*`: complaint, staff meal, regular
guest, promotion, on the house).

### API (`/api/v1`, `@RequireFeature('pos')`)

| Method + path                                     | Permission            | Idempotency                 | Body / query                                                                  |
| ------------------------------------------------- | --------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `POST /pos/bills`                                 | `pos.bills.print`     | `completion: 'transaction'` | `{ orderIds: 1–10, items?: [{ orderLineId, quantity 1–99 }], shares?: 2–20 }` |
| `GET /pos/bills/:id`                              | `pos.bills.print`     |                             |                                                                               |
| `POST /pos/bills/:id/cancel`                      | `pos.bills.cancel`    | `completion: 'transaction'` | `{ reason: 1–200 }`; cancelling a cancelled bill changes nothing              |
| `GET /pos/checks`                                 | `pos.bills.print`     |                             | `?locationId=&view=recent or history&from=&to=&q=&cursor=`; 50 per page       |
| `GET /pos/checks/:id`                             | `pos.bills.print`     |                             | the printable check                                                           |
| `POST /pos/orders/:id/discounts`                  | `pos.orders.discount` | `completion: 'transaction'` | `{ orderLineId?, kind: percent or amount, value, reason }`                    |
| `POST /pos/orders/:id/discounts/:discountId/void` | `pos.orders.discount` | `completion: 'transaction'` | no body                                                                       |

- `POST /pos/bills` without `items` bills everything unbilled on its orders; with `shares` it splits equally (then
  `items` is not allowed). The response is the bill with its checks.
- `recent` = checks of the last 24 hours, newest first; `history` = `from`/`to` (dates) and `q` (part of a check
  number), newest first, `cursor` for the next page. A check carries its bill's orders (numbers, tables), its lines
  (items or shares), discount lines, totals, `shareIndex`/`shareCount` and `cancelled`.
- The order (`GET /pos/orders/:id`, the till) gains `billedQuantity` per line, `discounts`, `bills` (with their
  checks) and `unbilled` (gross still to bill, after discounts); its totals include discounts.
- `POST /pos/print-jobs/bill` takes an optional `checkId` (a check of that order); the job prints that check. Jobs
  without one print from the order, as before.

### Errors

| Code                           | Status | When                                                                |
| ------------------------------ | ------ | ------------------------------------------------------------------- |
| `pos.bill_not_found`           | 404    | unknown bill, another tenant's, or a location the caller can't read |
| `pos.check_not_found`          | 404    | the same, for a check                                               |
| `pos.nothing_to_bill`          | 409    | nothing unbilled on the orders (or an empty item list)              |
| `pos.line_billed`              | 409    | billing more of a line than is unbilled, or voiding billed portions |
| `pos.orders_not_same_location` | 409    | a bill over orders of different locations                           |
| `pos.discount_needs_full_bill` | 409    | a whole-order discount and a bill that leaves items unbilled        |
| `pos.discount_line_whole`      | 409    | billing part of a discounted line                                   |
| `pos.discount_not_found`       | 404    | voiding an unknown discount of this order                           |
| `pos.discount_invalid`         | 409    | a value above 100 % or above what is left, or on billed items       |
| `pos.order_closed`             | 409    | billing or discounting a closed order                               |

### Audit

| Action                | Entity      | Snapshot fields                                                               |
| --------------------- | ----------- | ----------------------------------------------------------------------------- |
| `pos.bill.created`    | `pos_bill`  | `id`, `locationId`, `kind`, `shareCount`, `orderIds`, `checkNumbers`, `gross` |
| `pos.bill.cancelled`  | `pos_bill`  | the same                                                                      |
| `pos.discount.added`  | `pos_order` | `id`, `orderId`, `orderLineId`, `kind`, `value`, `amount`                     |
| `pos.discount.voided` | `pos_order` | the same                                                                      |

Reasons are free text and stay out of snapshots.

### Web

- **Checkout** (`/checkout`, nav "Checkout", `pos.bills.print`): **Open tables** (table, order, total, unbilled;
  opens the till), **Recent checks** (24 h), **History** (dates, number search, more pages). A check opens as its
  receipt with **Reprint** (same number) and, with `pos.bills.cancel`, **Cancel bill** (with a reason).
- **Till:** **Print bill** bills everything unbilled and prints the check (nothing unbilled: reprints the last
  check); **Split bill**: one dialog with three big choices. **By item**: each unbilled line with its price and
  what is left, − / + and All per line, Select all / Clear, and the new bill's item count and total; **Equally**:
  2–6 at one tap (starting from the table's guests) or − / + up to 20, with "about … each" (the api gives left-over
  cents to the first checks); **Join tables**: other open tables of the location with their amounts and the
  combined total. The button says what it creates ("Create bill", "Create 3 checks"). **Discount** (with `pos.orders.discount`: line or order, percent or
  amount, reason); lines show how much is billed; the order's bills list their checks.
- **Settings → Service:** the discount reasons.

## Step 6: seat numbers (ADR 0070)

An item sent to the kitchen may name a seat (1–20). The seat is stored on the line, copied to the void of that line
and to a transfer's sale line, and never changed (a correction is void and resend). Bills are unchanged: "bill seat
N" is a bill of the unbilled lines whose seat is N. Lines without a seat are billed as before. The order response
carries `seat` on each line.

## QR menu (ADR 0026)

Every dining table has a `menu_token` (24 random URL-safe characters, unique per tenant). Its QR code links to
`/menu/<organizationId>.<menuToken>`; guests see the menu without signing in.

| Method + path                     | Access                                            | Notes                                                          |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `GET /public/menu/:token`         | `@Public()`, rate-limited per IP                  | 404 for an unknown token, an archived table or no `pos`        |
| `POST /pos/tables/:id/menu-token` | `pos.tables.manage` at the table, `@Idempotent()` | new token; the old QR stops working; audited without the token |

- Response: `{ name, logo, tableName, currency, locale, categories: [{ name, products: [{ name, description,
price }] }] }`: the bill header's name and logo (else the organization's name), non-archived categories with
  their non-archived products in menu order. No ids, VAT rates or staff data.
- Tables (`GET /pos/tables`) carry it as `menuCode` for `pos.tables.read` holders, who print the QR (not
  "token": ADR 0014 §7 never stores replies with token-like keys).
- Web: Tables page → **QR** per table (code, link, print card, new code); public page `/menu/[token]`.

## Kitchen and bar screens (ADR 0026)

```
PosKitchenTicket ── PosTicketStatusChange   pos_ticket_status_changes   append-only; preparing | ready | served
```

A ticket's status is its latest change, else `new`. Moves: new → preparing | ready, preparing → ready, ready →
served, ready → preparing (undo); a void ticket new → served ("seen"). The current status again writes nothing;
any other move → 409 `pos.ticket_status_invalid`.

| Key               | Grants                                   | admin | manager | waiter | cashier | kitchen | bar |
| ----------------- | ---------------------------------------- | ----- | ------- | ------ | ------- | ------- | --- |
| `pos.kitchen.use` | the kitchen screen: see and move tickets | ✓     | ✓       |        |         | ✓       |     |
| `pos.bar.use`     | the bar screen                           | ✓     | ✓       |        |         |         | ✓   |

Staff and Host hold neither. Holders of `pos.orders.take` (waiters) may set `served` on a ready ticket only.
Kitchen and Bar are system roles holding their key and `platform.settings.read` only.

One route per station, so each declares its own key:

| Method + path                                                | Access                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `GET /pos/stations/kitchen/tickets?locationId=`              | `pos.kitchen.use` at the location (bar: `pos.bar.use`)    |
| `POST /pos/stations/kitchen/tickets/:id/status` `{ status }` | the station's key; `completion: 'transaction'`            |
| `POST /pos/orders/:orderId/tickets/:id/served`               | `pos.orders.take`; ready → served only; returns the order |

- The board lists the station's tickets at the location that are not served, plus those served in the last 15
  minutes (undo), oldest first: order number, table, sequence, kind, lines (name, quantity, note), status,
  `createdAt`, `statusAt`.
- Audit: `pos.kitchen_ticket.status_changed` (after: id, sequence, status).
- Orders: each ticket carries `status`; summaries carry `readyCount` (tickets ready, not served).
- Web: `/kitchen` and `/bar`: columns New, Preparing, Ready; a card per ticket with the table, age, items and
  one next-step button; refreshes every 5 s. The floor shows **Ready** on tables with ready tickets; the till's
  ticket log shows each status and **Served** on ready tickets.

## Kitchen and bar processing (ADR 0031)

- Settings `pos.kitchenProcessing` and `pos.barProcessing` (boolean, default `true`; organization, location
  override; `platform.settings.manage`). Off: that station's items go **straight to the bill**.
- A send still writes one ticket per station; a station that is off gets a ticket with `direct = true`
  (`pos_kitchen_tickets.direct`, snapshot at send time). A void copies the voided line's ticket's `direct`. The
  settings are read at the table's location inside the send's transaction.
- Direct tickets: not on the station screens, no status moves (409 `pos.ticket_status_invalid`), audited with
  `direct` in the snapshot. Totals, bill, voids and consumption are unchanged.
- `GET /pos/tables/:tableId/order` carries `processing: { kitchen, bar }` (effective values there); tickets carry
  `direct`.
- Web: Settings → **Kitchen & bar** (organization or one location; "Use the organization's setting" on a
  location). Till: the send button says **Add to bill** when nothing goes to a station; direct tickets print
  nothing on send and show **Added to bill** in the ticket log.
