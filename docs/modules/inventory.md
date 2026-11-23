# Inventory module

Stock of ingredients and goods per warehouse: what is there, what it is worth, and every movement. Feature
`inventory`. Step 1 (this document): warehouses, stock items, receipts, adjustments, transfers, stock on hand.
Later steps: recipes and dish cost with sales consumption (Step 2), prices per location and time (Step 3, catalog, ADR 0030),
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
- **Units** (ADR 0062): `kg` `g` `l` `ml` `pc` (the piece, Stück) and `box` `bucket` `bag` `packet` for goods bought
  and counted that way.
- **Best before** (ADR 0062): receipt, import receipt and vendor invoice lines may carry `expiresOn` ("2027-03-31").
  `stock_levels.expires_on` keeps the earliest date of what is in stock (goods coming in: the earlier of the level's
  and theirs; goods without a date leave it; transfers and branch requests carry it along; nothing left, no date);
  `stock_movements.expires_on` records the date goods came or went with. Stock, document lines, vendor invoice lines
  and the request cart's availability answer it; the stock tab and the overview show it, red once past. The earliest
  date, not batches.

## Permissions (location scope at the warehouse's location unless noted)

| Key                           | Grants                                  | admin | manager | staff | kitchen | bar | waiter, cashier, host |
| ----------------------------- | --------------------------------------- | ----- | ------- | ----- | ------- | --- | --------------------- |
| `inventory.stock.read`        | stock, documents, items, warehouses     | ✓     | ✓       | ✓     | ✓       | ✓   |                       |
| `inventory.stock.receive`     | receipts                                | ✓     | ✓       |       | ✓       | ✓   |                       |
| `inventory.stock.adjust`      | adjustments (waste, breakage, count, …) | ✓     | ✓       |       | ✓       | ✓   |                       |
| `inventory.stock.transfer`    | transfers (both warehouses' locations)  | ✓     | ✓       |       |         |     |                       |
| `inventory.invoices.approve`  | approve or reject vendor invoices       | ✓     | ✓       |       |         |     |                       |
| `inventory.warehouses.manage` | create, rename, archive warehouses      | ✓     | ✓       |       |         |     |                       |
| `inventory.items.manage`      | stock items (organization scope)        | ✓     |         |       |         |     |                       |

**Prices and values (ADR 0060).** `inventory.prices.read` (location scope, "See prices and values"): every
built-in role that reads stock but the Branch manager; custom roles got it with the release. Without it `GET /stock` answers
`averageCost` and `value` as null, documents (`GET /documents`, `/documents/:id` and the receipt, adjustment and
transfer answers) their values and unit costs, items their `salePrice`, and a sale price sent with an item is
ignored. The pages leave out those columns, totals and export columns. Audit rows keep the values.

## API (`/api/v1/inventory`, `@RequireFeature('inventory')`)

| Method + path              | Permission                    | Idempotency                 | Body / query                                                                                                                                                   |
| -------------------------- | ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /warehouses`          | `inventory.stock.read`        |                             | `?locationId=&includeArchived=true`                                                                                                                            |
| `POST /warehouses`         | `inventory.warehouses.manage` | `completion: 'transaction'` | `{ locationId, name, sortOrder? }`                                                                                                                             |
| `PATCH /warehouses/:id`    | `inventory.warehouses.manage` | response                    | `{ name?, sortOrder?, archived? }`                                                                                                                             |
| `GET /categories`          | `inventory.stock.read`        |                             | `?includeArchived=true`: the catalog's categories, for stock readers (0059)                                                                                    |
| `GET /items`               | `inventory.stock.read`        |                             | `?includeArchived=true`                                                                                                                                        |
| `POST /items`              | `inventory.items.manage`      | `completion: 'transaction'` | `{ name, sku?, unit, minQuantity? }`                                                                                                                           |
| `PATCH /items/:id`         | `inventory.items.manage`      | response                    | `{ name?, sku?, unit?, minQuantity?, archived? }`                                                                                                              |
| `POST /receipts`           | `inventory.stock.receive`     | `completion: 'transaction'` | `{ warehouseId, supplier?, note?, lines: [{ itemId, quantity, unitCost }] }`                                                                                   |
| `POST /adjustments`        | `inventory.stock.adjust`      | `completion: 'transaction'` | `{ warehouseId, reason, note?, lines: [{ itemId, quantity }] }` (signed)                                                                                       |
| `POST /transfers`          | `inventory.stock.transfer`    | `completion: 'transaction'` | `{ fromWarehouseId, toWarehouseId, note?, lines: [{ itemId, quantity }] }`                                                                                     |
| `GET /stock`               | `inventory.stock.read`        |                             | `?locationId=&warehouseId=` → levels with value and `low`                                                                                                      |
| `GET /documents`           | `inventory.stock.read`        |                             | `?locationId=&warehouseId=&kind=` → newest 200                                                                                                                 |
| `GET /documents/:id`       | `inventory.stock.read`        |                             | the document with its lines                                                                                                                                    |
| `GET /items/:id/movements` | `inventory.stock.read`        |                             | `?locationId=&warehouseId=` → the item's activity: newest 500 movements with the balance after each, opening, closing; costs only with `inventory.prices.read` |

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

### Categories and the operations inventory page (ADR 0048)

- A stock item has an optional `categoryId` from the organization's one category list (`product_categories`, shared
  with the catalog); only an active category. Variants take their parent's. The item dialog shows a Category field to
  people who can read categories (`catalog` feature and `catalog.products.read`).
- In the operations menu, Inventory is one item. `/inventory` there opens on:
  - filters: category, stock level (all / low / out) and warehouse;
  - category tiles: All items, each top-level category with its secondary ones counted in, and Uncategorized; a tile
    shows the category's image or a colour from the table palette;
  - "Find a category or product".

  A tile lists its items with quantity and value over the warehouses shown; chips narrow to a secondary category.
  **Export** downloads what is listed as CSV (UTF-8 with a byte order mark, so Excel opens it). **More** holds the
  other tabs and the setup pages. **Add New Item** files the item under a category. The default menu keeps the tabs.

- Code: `components/inventory/category-overview.tsx`, `lib/inventory/overview.ts`. Test page:
  docs/html/inventory-categories.html.

### Vendor invoices (ADR 0049, 0054, 0055, 0058)

`/inventory/invoice` (Import Vendor Invoice on the operations Inventory page, and a tile on Import Data;
`inventory.stock.receive`):

1. Choose the supplier's invoice or order confirmation: one PDF, or one or more photos. It is read on the device
   (`lib/inventory/invoice-pdf.ts`): a PDF's text, else on-device recognition (`scanRows`, the menu scan's OCR, rows
   rebuilt by `linesToRows`). Item lines (code, description, quantity, unit price, VAT, total), order number, date,
   supplier, grand total.
2. Review (`lib/inventory/invoice-receipt.ts`, `components/inventory/invoice-editor.tsx`): each line matched by SKU =
   supplier code, then exact name, else New; change item, quantity or cost, or leave a line out; pick the warehouse.
   New items get, per line, a category ("+" adds one, "Set for all" fills the rest), brand, pack size (read from the
   description, `lib/inventory/pack-size.ts`) and unit; any line may be invoiced in a unit of measurement ("+" adds
   one, e.g. Carton = 12 pc), converted to the item's unit on approval (ADR 0055). The total is checked against the
   invoice; "Show what was read" lists the rows read from the pages. Packed lines (wholesalers' "CAR 4 × 12") are
   counted as invoiced or by the piece, one switch for the invoice; free goods merge into their product's line;
   transport and similar charges are skipped and named (ADR 0058).
3. Send for approval: `POST /api/v1/inventory/invoices` stores it as pending (`VIN-…`) and notifies the approvers at
   the warehouse's location. Nothing is in stock yet.

`/inventory/invoices`, the approval queue (`components/inventory/invoice-queue-page.tsx`): Pending / Approved /
Rejected. Holders of `inventory.invoices.approve` correct a pending invoice (`PUT /invoices/:id`), approve it (new
items created and one goods receipt booked, in one transaction; `POST /invoices/:id/approve`) or reject it with a
reason (`POST /invoices/:id/reject`). The sender is notified either way.

| Method + path                | Permission                   | Idempotency                 |
| ---------------------------- | ---------------------------- | --------------------------- |
| `GET /invoices?status=`      | `inventory.stock.read`       |                             |
| `GET /invoices/:id`          | `inventory.stock.read`       |                             |
| `POST /invoices`             | `inventory.stock.receive`    | `completion: 'transaction'` |
| `PUT /invoices/:id`          | sender or approver, pending  | response                    |
| `POST /invoices/:id/approve` | `inventory.invoices.approve` | `completion: 'transaction'` |
| `POST /invoices/:id/reject`  | `inventory.invoices.approve` | `completion: 'transaction'` |

Test pages: docs/html/vendor-invoice.html (reading), docs/html/vendor-invoice-approval.html (queue, photos, Import
Data).

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

## Step 5: units, variants, bills of materials and production (ADR 0038)

The Inventory sidebar group lists Stock, Products, Variant Products, Variant Attributes, Product Category, Units of
Measurement, Inventory Adjustment, Bills of Materials and Production Order. Products and Product Category open the
catalog page; Inventory Adjustment opens the Adjust tab.

### Entities

| Table                | Columns                                                                                                                | Notes                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `units_of_measure`   | `id`, `tenant_id`, `name`, `symbol`, `base_unit` (`stock_unit`), `factor numeric(14,6) > 0`, `archived_at`, timestamps | name unique among active; base unit fixed; archived, never deleted        |
| `variant_attributes` | `id`, `tenant_id`, `name`, `values text[]` (1–50, unique, display order), `archived_at`, timestamps                    | name unique among active; archived, never deleted                         |
| `stock_items` (+)    | `parent_item_id?` (FK to `stock_items`), `variant_values text[]`                                                       | values exactly when a parent; one variant per combination; one level only |
| `boms`               | `id`, `tenant_id`, `item_id` (unique), `output_quantity numeric(14,3) > 0`, timestamps                                 | configuration: replaced as a whole, deleted freely                        |
| `bom_lines`          | `id`, `tenant_id`, `bom_id` (cascade), `item_id`, `quantity numeric(14,3) > 0`                                         | unique per bill and item; never the bill's own item                       |

`stock_document_kind` gains `production` (`PRD-…`, series `inventory.stockProduction`).

### Rules

- **Units.** A receipt line may carry `unitId`: its quantity and cost are in that unit and are converted to the item's
  unit (`quantity × factor`, 3 decimals; `unitCost ÷ factor`, 4 decimals, half up). The unit's base unit must be the
  item's unit and the converted quantity must not be zero (`inventory.unit_mismatch`). Stored movements are always in
  the item's unit.
- **Variants.** `POST /items/:id/variants` creates one stock item per combination of the picked values (1–3
  attributes, values in the attribute's order, at most 100), named `Parent · v1 / v2`, in the parent's unit, with
  optional article numbers `PREFIX-n`. Existing combinations are skipped. The parent must be active, not a variant, and
  without movements, recipe lines or bills (`inventory.variant_not_allowed`). Once it has active variants it holds no
  stock: stock documents, recipes and bills refuse it (`inventory.item_has_variants`). Changing an attribute's values
  never touches existing variants.
- **Bills of materials.** One per stock item: `outputQuantity` of the item takes the lines' quantities. `PUT` replaces
  it (the same bill again changes nothing), `DELETE` removes it; both audited (`inventory.bom.updated|deleted`).
- **Production.** `POST /productions { warehouseId, itemId, quantity, note? }` books one document in one warehouse:
  each component out at its average cost (bill quantity × quantity ÷ output quantity, 3 decimals; components that
  round to zero are skipped), then the item in at the components' total value ÷ quantity (4 decimals). Refused like
  any document that would take a component below zero (`inventory.allowNegativeStock`). One step: no drafts; a
  correction is an adjustment.

### API (`/api/v1/inventory`)

| Method + path                | Permission                 | Idempotency                 | Body                                                       |
| ---------------------------- | -------------------------- | --------------------------- | ---------------------------------------------------------- |
| `GET /units`                 | `inventory.stock.read`     |                             | `?includeArchived=true`                                    |
| `POST /units`                | `inventory.items.create`   | `completion: 'transaction'` | `{ name, symbol, baseUnit, factor }`                       |
| `PATCH /units/:id`           | `inventory.items.edit`     | response                    | `{ name?, symbol?, factor?, archived? }`                   |
| `GET /attributes`            | `inventory.stock.read`     |                             | `?includeArchived=true`                                    |
| `POST /attributes`           | `inventory.items.create`   | `completion: 'transaction'` | `{ name, values }`                                         |
| `PATCH /attributes/:id`      | `inventory.items.edit`     | response                    | `{ name?, values?, archived? }`                            |
| `POST /items/:id/variants`   | `inventory.items.create`   | `completion: 'transaction'` | `{ attributes: [{ attributeId, values }], skuPrefix? }`    |
| `GET /boms`, `/boms/:itemId` | `inventory.stock.read`     |                             | → bills with item names and units                          |
| `PUT /boms/:itemId`          | `inventory.recipes.edit`   | response                    | `{ outputQuantity, lines: [{ itemId, quantity }] }` (1–50) |
| `DELETE /boms/:itemId`       | `inventory.recipes.delete` | response                    | 204                                                        |
| `POST /productions`          | `inventory.stock.produce`  | `completion: 'transaction'` | `{ warehouseId, itemId, quantity, note? }` → the document  |

`inventory.stock.produce` (location scope, at the warehouse's location): admin, manager, kitchen and bar.

Errors: `inventory.unit_not_found` (404), `inventory.unit_name_taken` (409), `inventory.unit_mismatch` (400),
`inventory.attribute_not_found` (404), `inventory.attribute_name_taken` (409), `inventory.item_has_variants` (409),
`inventory.variant_not_allowed` (409), `inventory.too_many_variants` (400), `inventory.bom_not_found` (404),
`inventory.bom_invalid` (400).

Audit: `inventory.unit.created|updated`, `inventory.variant_attribute.created|updated`, `inventory.bom.updated|deleted`;
each variant is an `inventory.stock_item.created`; a production order is an `inventory.stock_document.created`.

### Web

Inventory → **Units of Measurement**, **Variant Attributes**, **Variant Products** (items with variants, Generate
variants), **Bills of Materials** (edit per prepared item) and **Production Order** (make an item in a warehouse, with
the components and their stock); receipts offer each line's matching units.

## Sale price (ADR 0044)

`stock_items.sale_price` (2 decimals, optional): the default unit price when the item is added to a sales order
(docs/modules/orders.md). Set in the item dialog while the organization has the `orders` feature; in the item's audit
snapshot.

## Vendor invoice corrections (ADR 0078)

An approved invoice's line can be corrected: `POST /inventory/invoices/:id/lines/:lineId/corrections` (approvers, `inventory.invoices.approve`). It books an adjustment (reason `correction`) for the line's current quantity and a receipt for the corrected quantity at the corrected unit cost, then records the correction. Pending invoices are changed as before. Lines of new items can't be corrected yet (approval doesn't record the item it created), and a correction is refused when the stock to take out has been used since.
