# Inventory module

Stock of ingredients and goods per warehouse: what is there, what it is worth, and every movement. Feature
`inventory`. Step 1 (this document): warehouses, stock items, receipts, adjustments, transfers, stock on hand.
Later steps: recipes and dish cost with sales consumption (Step 2), prices per location and time (Step 3, catalog),
the sales profit report (Step 4, reports). ADR 0027.

## Entities

```
Location
 └─ Warehouse          warehouses          main store, kitchen, bar, cold room …
Organization
 └─ StockItem          stock_items         tomatoes (kg), flour (kg), cola 0.33 (pc) …
StockDocument          stock_documents     append-only; receipt | adjustment | transfer, numbered
 └─ StockMovement      stock_movements     append-only ledger; signed quantity, unit cost, value
StockLevel             stock_levels        projection per warehouse and item: quantity, average cost
```

| Table             | Columns                                                                                                                                               | Notes                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `warehouses`      | `id`, `tenant_id`, `location_id`, `name`, `sort_order`, `archived_at`, timestamps                                                                     | name unique per location among non-archived; archived, never deleted                 |
| `stock_items`     | `id`, `tenant_id`, `name`, `sku?`, `unit` (`kg` `g` `l` `ml` `pc`), `min_quantity numeric(14,3)?`, `archived_at`, timestamps                          | organization-wide; name unique among non-archived; the unit never changes once moved |
| `stock_documents` | `id`, `tenant_id`, `number`, `kind`, `warehouse_id`, `to_warehouse_id?`, `reason?`, `supplier?`, `note?`, `created_by_user_id`, `created_at`          | append-only; `UNIQUE (tenant_id, number)`; `to_warehouse_id` exactly for transfers   |
| `stock_movements` | `id`, `tenant_id`, `document_id`, `warehouse_id`, `item_id`, `quantity numeric(14,3)`, `unit_cost numeric(14,4)`, `value numeric(14,2)`, `created_at` | append-only; quantity ≠ 0; value = quantity × unit cost, rounded to cents            |
| `stock_levels`    | `tenant_id`, `warehouse_id`, `item_id` (key), `quantity numeric(14,3)`, `average_cost numeric(14,4)`, `updated_at`                                    | the ledger's current state, updated in the document's transaction under a row lock   |

- **Documents** are numbered by series: receipts `inventory.goodsReceipt` (`GR-…`), adjustments
  `inventory.stockAdjustment` (`ADJ-…`), transfers `inventory.stockTransfer` (`TRF-…`), allocated last in the
  transaction (ADR 0012).
- **Valuation: weighted average per warehouse and item** (ADR 0027). A receipt line at unit cost `c` for `q` on a
  level `(Q, A)` gives `A' = (Q·A + q·c) / (Q + q)` (or `c` when `Q ≤ 0`), rounded to 4 decimals. Outgoing
  quantities (negative adjustments, transfer out) move at the current average; a transfer brings that cost into the
  target warehouse like a receipt. A positive adjustment (found stock) comes in at the current average.
  `inventory.valuationMethod = fifo` is not supported yet: stock writes answer 409 `inventory.valuation_unsupported`.
- **Negative stock** only with `inventory.allowNegativeStock` at the warehouse's location; otherwise a document
  that would take a level below zero answers 409 `inventory.insufficient_stock` (`details.itemIds`).
- **Corrections** are new documents; nothing is edited or deleted (CLAUDE.md rule 7).
- An item's **unit** can't change once it has movements (409 `inventory.unit_locked`).

## Permissions (location scope at the warehouse's location unless noted)

| Key                           | Grants                                  | admin | manager | staff | kitchen | bar | waiter, cashier, host |
| ----------------------------- | --------------------------------------- | ----- | ------- | ----- | ------- | --- | --------------------- |
| `inventory.stock.read`        | stock, documents, items, warehouses     | ✓     | ✓       | ✓     | ✓       | ✓   |                       |
| `inventory.stock.receive`     | receipts                                | ✓     | ✓       |       | ✓       | ✓   |                       |
| `inventory.stock.adjust`      | adjustments (waste, breakage, count, …) | ✓     | ✓       |       | ✓       | ✓   |                       |
| `inventory.stock.transfer`    | transfers (both warehouses' locations)  | ✓     | ✓       |       |         |     |                       |
| `inventory.warehouses.manage` | create, rename, archive warehouses      | ✓     | ✓       |       |         |     |                       |
| `inventory.items.manage`      | stock items (organization scope)        | ✓     |         |       |         |     |                       |

## API (`/api/v1/inventory`, `@RequireFeature('inventory')`)

| Method + path           | Permission                    | Idempotency                 | Body / query                                                                 |
| ----------------------- | ----------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `GET /warehouses`       | `inventory.stock.read`        |                             | `?locationId=&includeArchived=true`                                          |
| `POST /warehouses`      | `inventory.warehouses.manage` | `completion: 'transaction'` | `{ locationId, name, sortOrder? }`                                           |
| `PATCH /warehouses/:id` | `inventory.warehouses.manage` | response                    | `{ name?, sortOrder?, archived? }`                                           |
| `GET /items`            | `inventory.stock.read`        |                             | `?includeArchived=true`                                                      |
| `POST /items`           | `inventory.items.manage`      | `completion: 'transaction'` | `{ name, sku?, unit, minQuantity? }`                                         |
| `PATCH /items/:id`      | `inventory.items.manage`      | response                    | `{ name?, sku?, unit?, minQuantity?, archived? }`                            |
| `POST /receipts`        | `inventory.stock.receive`     | `completion: 'transaction'` | `{ warehouseId, supplier?, note?, lines: [{ itemId, quantity, unitCost }] }` |
| `POST /adjustments`     | `inventory.stock.adjust`      | `completion: 'transaction'` | `{ warehouseId, reason, note?, lines: [{ itemId, quantity }] }` (signed)     |
| `POST /transfers`       | `inventory.stock.transfer`    | `completion: 'transaction'` | `{ fromWarehouseId, toWarehouseId, note?, lines: [{ itemId, quantity }] }`   |
| `GET /stock`            | `inventory.stock.read`        |                             | `?locationId=&warehouseId=` → levels with value and `low`                    |
| `GET /documents`        | `inventory.stock.read`        |                             | `?locationId=&warehouseId=&kind=` → newest 200                               |
| `GET /documents/:id`    | `inventory.stock.read`        |                             | the document with its lines                                                  |

Quantities are decimal strings with up to 3 decimals, unit costs up to 4, values 2 (rule 6). Lines: 1–200, an item
at most once per document, items not archived, warehouses not archived; a transfer needs two different warehouses.

### Errors

`inventory.warehouse_not_found` (404), `inventory.location_not_found` (404), `inventory.item_not_found` (404, `details.itemIds`),
`inventory.document_not_found` (404), `inventory.warehouse_name_taken` (409), `inventory.item_name_taken` (409),
`inventory.insufficient_stock` (409, `details.itemIds`), `inventory.unit_locked` (409),
`inventory.valuation_unsupported` (409), `inventory.same_warehouse` (400).

### Audit

`inventory.warehouse.created|updated`, `inventory.stock_item.created|updated`, `inventory.stock_document.created`
(after: id, number, kind, warehouseId, toWarehouseId, reason, lineCount; never `note` or `supplier`).

## Web

Inventory (nav, feature `inventory`): tabs **Stock** (per location and warehouse, search, low-stock filter, value
total), **Receive**, **Adjust**, **Transfer** (line forms with item search and live totals), **Documents** (list
and detail), **Items**, **Warehouses**.

## Step 2: recipes, dish cost and sales consumption (ADR 0028)

### Recipes

`recipe_lines` (`product_id`, `item_id`, `quantity numeric(14,3) > 0` in the item's unit), unique per product and
item. The product id has **no foreign key** to catalog's `products`: a recipe must never make a product look sold to
the bulk delete (ADR 0024). Products are checked through `CatalogService`; recipes of deleted or archived products
are ignored. Recipes are configuration: replaced as a whole, audited (`inventory.recipe.updated`).

| Method + path             | Permission                 | Idempotency | Body                                       |
| ------------------------- | -------------------------- | ----------- | ------------------------------------------ |
| `GET /recipes/:productId` | `inventory.stock.read`     |             | → `{ productId, lines: [{ itemId, … }] }`  |
| `PUT /recipes/:productId` | `inventory.recipes.manage` | response    | `{ lines: [{ itemId, quantity }] }` (0–50) |
| `GET /costs`              | `inventory.costs.read`     |             | → per product with a recipe                |

### Dish cost

An item's **current cost** is the organization-wide weighted average over warehouses with stock on hand; with none,
the unit cost of its last movement; an item never moved has no cost. A dish costs Σ quantity × current cost, and is
`complete` when every item has a cost. The web shows cost, margin on the **net** price (price ÷ (1 + VAT)) and food
cost % next to each product, and a suggested price = cost ÷ `inventory.targetFoodCostPercent` × (1 + VAT)
(setting, organization scope, 1–100, default 30).

### Consumption

pos writes `pos.kitchen_ticket.created` (v1) with each ticket. The inventory handler (`inventory.consumeTicket`)
books a **consumption** document (`CON-…`, `stock_documents.source_ticket_id`, unique) for the lines whose product
has a recipe: recipe quantity × line quantity out of the warehouse that **supplies the ticket's station** at the
location (`warehouses.supplies_station`, at most one per location and station; set on the Warehouses tab), else the
location's first active warehouse; no warehouse → nothing. Sales are never blocked by negative stock. A void ticket
puts the quantities back at the unit cost the cancelled items went out at. A redelivered event changes nothing.

| Key                        | Scope        | admin | manager | others |
| -------------------------- | ------------ | ----- | ------- | ------ |
| `inventory.recipes.manage` | organization | ✓     | ✓       |        |
| `inventory.costs.read`     | organization | ✓     | ✓       |        |
