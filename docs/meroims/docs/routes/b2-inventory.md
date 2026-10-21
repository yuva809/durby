# Route dossiers — b2-inventory

Generated from `evidence/routes/b2-inventory.json` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)
and `evidence/captures/shapes-b2-inventory.txt` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted.
Blocked write attempts in this batch: 0

## `/inventory/{id}` — [record title redacted]

- Row open: clicked (/inventory → /inventory/{id})
- Headings: [record title redacted] · Inventory Ledger · Item Activity
- Actions/buttons: View photo · Adjust Stock
- Table columns: DATE | TYPE | WAREHOUSE | #NO | IN | OUT | BALANCE  ‖  DATE | TYPE | CHANGE | QUANTITY | PURCHASE PRICE | REMARKS
- API calls:
  - `GET /api/core/lookups`
  - `GET /api/core/products ?{page,perPage,warehouseId}`
  - `GET /api/core/products ?{page,perPage}`
  - `GET /api/core/reports/business/inventory-ledger ?{from,itemIds,to,warehouseId}`
  - `GET /api/core/stock/expiry ?{status,warehouseId,withinDays}`
  - `GET /api/core/stock/levels ?{warehouseId}`
  - `GET /api/core/stock/movements ?{perPage,productId,warehouseId}`
  - `GET /api/core/warehouses ?{includeBranchStores}`

## `/inventory/new` — Add New Item

- Headings: Add New Item · ITEM DETAILS · PRICING & STOCK · ADDITIONAL INFORMATION
- Actions/buttons: IMAGE · Goods · Services · Add category · Select units Configure · ADDITIONAL INFORMATION · Cancel · Add Item
- Form fields:  [file] · Barcode [text] · Category [select-one] · Description (Optional) [textarea] · HS Code [text] · Item Code [text] · Item Name* [text] · Opening Stock [text] · Perishable — track batches and expiry dates [checkbox] · Purchase Price (Rs.) [text] · Reorder Level [text] · Sales Price (Rs.) [text] · Tax [select-one]
- API calls:
  - `GET /api/accounting/chart-accounts`
  - `GET /api/core/lookups`
  - `GET /api/core/warehouses`

## `/inventory/variant-products` — Variant Products

- Row open: clicked (/inventory/variant-products → /inventory/variant-products)
- Headings: Variant Products
- Actions/buttons: Add New
- Table columns: CODE/SKU | NAME | CATEGORY | TAX | VARIANTS
- API calls:
  - `GET /api/core/lookups`
  - `GET /api/core/products ?{page,perPage}`

## `/inventory/variant-products/new` — New Product Variant

- Headings: New Product Variant · PRODUCT INFORMATION
- Actions/buttons: Save · Goods · Services · Add unit · Add More Variants · Generate Variants
- Form fields:  [select-one] · Category* [select-one] · Code* [text] · HS Code [text] · Name* [text] · Primary Unit* [select-one] · Purchase Price* [text] · Selling Price [text] · Tax [select-one]
- API calls:
  - `GET /api/core/lookups`
  - `GET /api/core/variant-attributes`

## `/inventory/variant-attributes` — Variant Attributes

- Headings: Variant Attributes
- Actions/buttons: Active · Add Attribute
- Table columns: NAME | OPTIONS
- API calls:
  - `GET /api/core/variant-attributes`

## `/inventory/product-category` — Product Category

- Headings: Product Category
- Actions/buttons: Active · Add Category
- Form fields: Search categories... [text]
- API calls:
  - `GET /api/core/lookups`

## `/inventory/units` — Units Of Measurement

- Headings: Units Of Measurement
- Actions/buttons: Active · Add Unit
- Form fields: Search units... [text]
- API calls:
  - `GET /api/core/lookups`

## `/inventory/adjustment` — Inventory Adjustment

- Row open: clicked (/inventory/adjustment → /inventory/adjustment)
- Headings: Inventory Adjustment · Recent Movements
- Actions/buttons: Adjust Stock
- Table columns: ITEM | ON HAND | RESERVED | AVAILABLE | AVG COST | STOCK VALUE | ACTIONS  ‖  WHEN | ITEM | TYPE | QUANTITY | UNIT COST | REASON
- Form fields: Search items by name or SKU... [text]
- API calls:
  - `GET /api/core/products ?{page,perPage}`
  - `GET /api/core/stock/levels ?{warehouseId}`
  - `GET /api/core/stock/movements ?{page,perPage,warehouseId}`
  - `GET /api/core/stock/movements ?{page,perPage}`
  - `GET /api/core/warehouses ?{includeBranchStores}`

## `/inventory/documents` — OC / DC Documents

- Row open: no-rows (/inventory/documents → /inventory/documents)
- Headings: OC / DC Documents · No documents yet
- Actions/buttons: All · Order confirmations (OC) · Delivery challans (DC)
- Form fields: Filter by branch [select-one] · Filter by warehouse [select-one] · From date [date] · Search documents [search] · To date [date]
- API calls:
  - `GET /api/core/stock/requests/confirmations ?{page,perPage}`

## `/inventory/bom` — Bills Of Materials

- Row open: no-rows (/inventory/bom → /inventory/bom)
- Headings: Bills Of Materials · Coming soon
- Actions/buttons: 
- API calls: (none beyond shell)

## `/inventory/production-order` — Production Order

- Row open: no-rows (/inventory/production-order → /inventory/production-order)
- Headings: Production Order · Coming soon
- Actions/buttons: 
- API calls: (none beyond shell)

## `/inventory/expiry` — Expiry batches

- Headings: Expiry batches · Nothing to act on
- Actions/buttons: 
- Form fields: Filter by location [select-one] · Filter by status [select-one] · Warning window [select-one]
- Empty state: No dated stock matches. Mark an item perishable to record batch and expiry dates at stock-
- API calls:
  - `GET /api/core/stock/expiry ?{status,withinDays}`

## `/stock-requests` — Stock Request

- Headings: Stock Request · No moves between warehouses yet
- Actions/buttons: Branch requests · Between warehouses · All · Draft · Awaiting approval · Approved · Packed · Driver assigned · Verified · In transit · Delivered · Received · Rejected · Cancelled
- Tabs: Branch requests · Between warehouses
- Table columns: TRANSFER | FROM | TO | ITEMS | STATUS | CREATED
- Form fields: Search by transfer number... [search]
- API calls:
  - `GET /api/core/stock/requests ?{page,perPage}`
  - `GET /api/core/stock/transfers ?{origin,page,perPage}`
  - `GET /api/core/stock/transfers ?{origin,page,perPage}  ← tab Between warehouses`
- Tab views:
  - **Branch requests**: headings Stock Request; fields 2; columns REQUEST | BRANCH | INTO | ITEMS | REQUESTED BY | DATE | STATUS | OC / DC | TRANSFER | ACTIONS
  - **Between warehouses**: headings Stock Request · No moves between warehouses yet; fields 1; columns TRANSFER | FROM | TO | ITEMS | STATUS | CREATED

