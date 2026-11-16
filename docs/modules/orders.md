# Orders module

- Code: `apps/api/src/modules/orders/`, `packages/shared/src/api/orders.ts`, `apps/web/components/orders/`,
  `apps/web/lib/orders/`
- Decisions: [ADR 0044](../adr/0044-operations-menu-orders-fulfilment.md)
- Feature: `orders` (depends on `inventory`; in every plan with inventory)

Sales orders of a distribution business (AsiaMight): staff enter an order for a customer, it leaves from one
warehouse, and later steps pick, pack and deliver it. Orders sell **stock items**, not menu products, so they are a
module of their own beside table service.

## Entities

| Table                | What                                                        | Notes                                                                            |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `order_customers`    | name, code?, phone?, email?, address?, note?, archived_at   | Organization-wide. Archived, never deleted. `code` unique among active customers |
| `sales_orders`       | number, status, customer, location, warehouse, total, …     | `location_id` = the warehouse's location (access and filters). Never deleted     |
| `sales_order_lines`  | item, quantity (3 dp), unit price (2 dp), line total (2 dp) | Replaced as a whole while the order is a draft                                   |
| `sales_order_events` | status, note?, user, time                                   | The timeline. **Append-only** (trigger + revoked UPDATE/DELETE)                  |
| `stock_items`        | + `sale_price` (2 dp, nullable)                             | The default unit price on new order lines                                        |

RLS (`tenant_isolation`) on all four new tables. Numbers come from the series `orders.salesOrder`
(`SO-{YYYY}-{seq:6}`, yearly, ADR 0012).

### Money

Line total = quantity × unit price rounded half up to cents (`decimal.js`); the order total is the sum of the rounded
line totals. The web shows the same preview with BigInt cents (`lib/orders/form.ts`). Never floats (CLAUDE.md rule 6).

### Statuses

`draft → confirmed → picking → packed → dispatched → delivered`, and `cancelled` from draft, confirmed, picking or
packed. Step 2 has **confirm** (draft → confirmed) and **cancel**; picking, packing and delivery come with step 3. A
draft can be edited; anything else answers `orders.not_editable`. Every move writes a timeline row and an audit row,
under a row lock (`SELECT … FOR UPDATE`), so two clicks can't both move it.

## Permissions

| Key                       | Scope        | Owner | Admin | Manager | Staff | Restaurant roles |
| ------------------------- | ------------ | ----- | ----- | ------- | ----- | ---------------- |
| `orders.orders.read`      | location     | ✓     | ✓     | ✓       | ✓     | –                |
| `orders.orders.create`    | location     | ✓     | ✓     | ✓       | –     | –                |
| `orders.orders.edit`      | location     | ✓     | ✓     | ✓       | –     | –                |
| `orders.customers.read`   | location     | ✓     | ✓     | ✓       | ✓     | –                |
| `orders.customers.create` | organization | ✓     | ✓     | ✓       | –     | –                |
| `orders.customers.edit`   | organization | ✓     | ✓     | ✓       | –     | –                |

Order keys are checked at the order's branch (the warehouse's location): an order elsewhere is 404 without read, 403
without the write key. They show as Create / Edit / View columns in Add Staff (ADR 0037).

## API (`/api/v1/orders`, `@RequireFeature('orders')`)

| Route                  | Key                       | Notes                                                                                                                     |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /customers`       | `orders.customers.read`   | `?includeArchived=true`                                                                                                   |
| `POST /customers`      | `orders.customers.create` | Idempotent, completes in the transaction                                                                                  |
| `PATCH /customers/:id` | `orders.customers.edit`   | Fields, `archived`                                                                                                        |
| `GET /`                | `orders.orders.read`      | `status` (repeatable), `locationId`, `customerId`, `from`, `to`, `limit` ≤ 200, `cursor`; newest first                    |
| `GET /:id`             | `orders.orders.read`      | With lines and timeline                                                                                                   |
| `POST /`               | `orders.orders.create`    | `customerId`, `warehouseId`, `lines[]` (each item once, ≤ 200), `requestedDate?`, `deliveryAddress?`, `note?`, `confirm?` |
| `PATCH /:id`           | `orders.orders.edit`      | Drafts only; `lines` replace all lines                                                                                    |
| `POST /:id/confirm`    | `orders.orders.edit`      | draft → confirmed                                                                                                         |
| `POST /:id/cancel`     | `orders.orders.edit`      | `reason?`; up to packed                                                                                                   |

Lines refuse unknown or archived items and parents with variants (`orders.item_not_found`, ADR 0038).

### Errors

`orders.customer_not_found`, `orders.customer_code_taken`, `orders.order_not_found`, `orders.warehouse_not_found`,
`orders.item_not_found`, `orders.not_editable`, `orders.invalid_transition`.

### Audit

`orders.customer.created|updated` (snapshot: id, code, archive time — **no contact details**),
`orders.sales_order.created|updated|status_changed` (number, status, customer, location, warehouse, line count, total
— no address or notes). Both show under the module "Orders" in the audit log.

## Web

- **Order History** (`/orders`, operations menu): a table (order, date, customer, branch · warehouse, items, total,
  status), filters for status, branch and dates (sent to the api), a search over the loaded orders, Load more. A row
  opens the order in a side panel: facts, lines with totals, timeline; Edit and Confirm on drafts, Cancel with an
  optional reason.
- **New order** dialog: customer (with "New customer" inline), warehouse ("ships from"; preselected when there is one),
  requested date, delivery address (filled from the customer's address), items with quantity and price (the sale
  price to start with), a live total, "Confirm at once" (on by default).
- **Customers** (`/orders/customers`): list, add, edit, archive / restore.
- **Inventory → item**: "Sale price" while the organization has `orders`.

## Tests

- API unit: `order-math.spec.ts` (rounding, totals, allowed moves, cursor).
- API e2e (Docker): `test/orders.e2e.spec.ts` — customers and code uniqueness, no contact details in audit rows,
  create / edit / confirm / cancel with exact totals and the timeline, confirm at once, paging and filters, refused
  items / customers / warehouses, staff read-only, other organizations see nothing.
- Web: `components/orders/orders.test.tsx`, `lib/orders/form.test.ts`.

## Step 3: picking and delivery

| Route                     | Key                   | From → to                                                                         |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `POST /:id/start-picking` | `orders.picking.use`  | confirmed → picking                                                               |
| `POST /:id/pick`          | `orders.picking.use`  | confirmed / picking → packed; `lines[]` = every line once, `0` ≤ picked ≤ ordered |
| `POST /:id/dispatch`      | `orders.delivery.use` | packed → dispatched; `driverName?`, `driverPhone?`, `vehicle?`, `note?`           |
| `POST /:id/deliver`       | `orders.delivery.use` | dispatched → delivered; `note?` (who received it)                                 |
| `POST /:id/return`        | `orders.delivery.use` | dispatched → returned; `note?` (why)                                              |

Both keys are location-scoped (admin and manager by default; give them to warehouse staff in Add Staff). All five
complete their idempotency key in the business transaction.

- **Stock.** Picking books one `issue` stock document (`GI-YYYY-000001`) for the picked quantities at the average
  cost, refused below zero unless the branch allows negative stock (`inventory.insufficient_stock`; the order stays
  where it was). A return, or a cancel after picking, books one `restock` document (`RS-…`) at the cost the goods
  went out at. Both name the order (`stock_documents.source_order_id`) and show in Inventory → Documents.
- **Short picks.** A line can be picked below what was ordered (0 = nothing on the shelf); the order ships what was
  picked. `sales_order_lines.picked_quantity` keeps it.
- **Delivery details** (`driver_name`, `driver_phone`, `vehicle`, `dispatched_at`, `delivered_at`) live on the order,
  never in audit snapshots (personal data).
- **Statuses** now: draft → confirmed → (picking) → packed → dispatched → delivered | returned; cancel up to packed.

### Web

- **Picking** (`/picking`): confirmed and picking orders, oldest first, filter by warehouse. "Start picking"; "Pick"
  opens the lines with the ordered quantities filled in ("All as ordered"), shows short lines, refuses more than
  ordered, and "Picked and packed" books the stock.
- **Delivery Tracking** (`/deliveries`): three columns, Ready to dispatch (packed), On the way (dispatched, with driver
  and time), Delivered (last 7 days). Dispatch asks for driver, phone, vehicle and a note; Delivered asks who received
  it; Came back asks why and books the goods back in.
- The order panel shows picked quantities and the delivery details.

### Tests

- Web: `components/orders/fulfilment.test.tsx` (queue order, pick with prefilled and short quantities, over-pick
  refused, board columns, dispatch body, return with reason).
- API e2e (Docker): `test/orders.e2e.spec.ts` → picking and delivery: stock after pick, issue numbering, full
  timeline, driver phone kept out of the audit log, returns and cancels booking back at issue cost, insufficient
  stock refused, keys enforced.

## Later

Partial re-picks of short lines, proof of delivery (photo or signature), delivery notes to print.
