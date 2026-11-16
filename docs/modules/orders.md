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

## Later (step 3)

Picking (a stock issue document on confirm of the pick list), packing, dispatch with driver details, delivery and
returns.
