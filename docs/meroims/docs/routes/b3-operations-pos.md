# Route dossiers — b3-operations-pos

Generated from `evidence/routes/b3-operations-pos.json` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)
and `evidence/captures/shapes-b3-operations-pos.txt` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted.
Blocked write attempts in this batch: 0

## `/parties` — Parties

- Row open: no-rows (/parties → /parties)
- Headings: Parties · PARTY DIRECTORY · Select a party
- Actions/buttons: Add Party · Parties · Categories · All · Customer · Supplier · NAME · BALANCE · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · Previous page · [record button] · [record button] · Next page
- Tabs: All · Customer · Supplier
- Form fields: Search parties... [text]
- API calls:
  - `GET /api/accounting/party-balances ?{asOf}`
  - `GET /api/core/accounts`
  - `GET /api/core/documents ?{page,perPage}`
  - `GET /api/core/lookups`
  - `GET /api/core/parties ?{page,perPage}`
  - `GET /api/core/payments ?{page,perPage}`
- Tab views:
  - **All**: headings Parties · PARTY DIRECTORY · Select a party; fields 1; columns 
  - **Customer**: headings Parties · PARTY DIRECTORY · Select a party; fields 1; columns 
  - **Supplier**: headings Parties · PARTY DIRECTORY · Select a party; fields 1; columns 

## `/branches` — Branches

- Row open: no-rows (/branches → /branches)
- Headings: Branches · No branches yet
- Actions/buttons: Add Branch · Show archived
- Form fields: Search branches... [text]
- API calls:
  - `GET /api/core/branches ?{page,perPage}`
  - `GET /api/core/staffs ?{page,perPage,status}`

## `/warehouses` — Warehouses

- Row open: clicked (/warehouses → /warehouses)
- Headings: Warehouses
- Actions/buttons: Add Warehouse · Show archived
- Table columns: WAREHOUSE | BRANCHES | ADDRESS | CONTACT | STAFF | STATUS
- Form fields: Search warehouses or branches... [text]
- API calls:
  - `GET /api/core/branches ?{page,perPage}`
  - `GET /api/core/staffs ?{page,perPage,status}`
  - `GET /api/core/warehouses`

## `/stock-requests` — Stock Request

- Row open: clicked (/stock-requests → /stock-requests)
- Headings: Stock Request
- Actions/buttons: Branch requests · Between warehouses · Active · Archived
- Tabs: Branch requests · Between warehouses · Active · Archived
- Table columns: REQUEST | BRANCH | INTO | ITEMS | REQUESTED BY | DATE | STATUS | OC / DC | TRANSFER | ACTIONS
- Form fields: Filter by status [select-one] · Search by request or transfer number... [text]
- API calls:
  - `GET /api/core/stock/requests ?{page,perPage}`
  - `GET /api/core/stock/transfers ?{origin,page,perPage}  ← tab Between warehouses`
- Tab views:
  - **Branch requests**: headings Stock Request; fields 2; columns REQUEST | BRANCH | INTO | ITEMS | REQUESTED BY | DATE | STATUS | OC / DC | TRANSFER | ACTIONS
  - **Between warehouses**: headings Stock Request · No moves between warehouses yet; fields 1; columns TRANSFER | FROM | TO | ITEMS | STATUS | CREATED

## `/stock-requests/new` — New Stock Request

- Headings: New Stock Request
- Actions/buttons: For a branch · Between warehouses · Create Move
- Tabs: For a branch · Between warehouses
- Form fields: From warehouse [select-one] · Note (optional) [textarea] · To warehouse [select-one]
- Empty state: Nothing added yet. Choose a category and press Add on an item.
- API calls:
  - `GET /api/core/warehouses ?{includeBranchStores}`

## `/picking` — Picking

- Headings: Picking · Nothing to pick right now
- Actions/buttons: To pick · Packed · Received
- Tabs: To pick · Packed · Received
- Form fields: Search transfers [search]
- API calls:
  - `GET /api/core/stock/transfers ?{packed,page,perPage}  ← tab Packed`
  - `GET /api/core/stock/transfers ?{page,perPage,status}`
  - `GET /api/core/stock/transfers ?{page,perPage,status}  ← tab Received`
- Tab views:
  - **To pick**: headings Picking · Nothing to pick right now; fields 1; columns 
  - **Packed**: headings Picking · Nothing packed yet; fields 1; columns 
  - **Received**: headings Picking · Nothing packed yet; fields 1; columns 

## `/delivery-tracking` — Delivery Tracking

- Headings: Delivery Tracking · No deliveries on the road
- Actions/buttons: Refresh · Zoom in · Zoom out
- API calls:
  - `GET /api/core/stock/transfers ?{page,perPage,status}`

## `/orders` — Orders

- Row open: clicked (/orders → /orders)
- Headings: Orders
- Actions/buttons: Manage
- Table columns: ORDER | CUSTOMER | TYPE | TOTAL | PAYMENT | STATUS
- Form fields:  [select-one]
- API calls:
  - `GET /api/pos/admin/users`
  - `GET /api/pos/orders ?{page,perPage}`

## `/till` — [tenant redacted]

- Headings: [tenant redacted]
- Actions/buttons: X-report · Cash in/out · Close shift · Scroll categories left · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · Scroll categories right · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · Previous page · Next page · W Walk-in customer tap to attach a customer attach · [record button] · [record button] · [record button] · Walk-in · Browse · Tender
- Tabs: All 70 · Beverages 7 · Bakery & Bread 6 · Breakfast & Cereals 6 · Canned & Preserved Goods 6 · Condiments & Sauces 6 · Frozen Foods 6 · Household & Cleaning 6 · Personal Care & Hygiene 6 · Snacks & Confectionery 6 · Spices, Oils & Seasonings 6 · Biscuits 3 · Chocolate 3 · Noodles 2 · Snacks 1
- Form fields: Scan barcode, or type a name / SKU… [text]
- API calls:
  - `GET /api/pos/products ?{registerId}`
  - `GET /api/pos/retail/context`
  - `GET /api/pos/retail/holds`

## `/pos-settings` — POS Settings

- Headings: POS Settings · Selling channels · Receipt details · Till background logo · Registers · Bank QR payments · Discount codes
- Actions/buttons: Open retail till ↗ · Save receipt details · [record button] · Add · Add account · Turn off · Remove · Add code
- Form fields:  [file] · Account name* [text] · Account number* [text] · Address [text] · Bank Choose a bank… Agricultural Development Bank Citizens Bank International Everest Bank* [select-one] · Branch [select-one] · Branch for [staff redacted] [select-one] · Code* [text] · Ends (optional) [datetime-local] · Minimum order total [text] · PAN/VAT number [text] · Percent (max 100)* [text] · Phone [text] · Register name (e.g. Till 1)* [text] · Starts (optional) [datetime-local] · Store name* [text] · Total uses (blank = unlimited) [text] · Type Percentage off Fixed amount off [select-one]
- Empty state: No discount codes yet
- API calls:
  - `GET /api/pos/admin/bank-accounts`
  - `GET /api/pos/admin/discount-codes`
  - `GET /api/pos/admin/registers`
  - `GET /api/pos/admin/settings`

## `/pms` — PMS

- Headings: PMS
- Actions/buttons: Configure
- Table columns: PARTY | CONTACT | INITIAL SERVICE DATE | INTERVAL | NEXT DUE | LAST NOTIFIED
- Form fields: Schedule filter [select-one] · Search name or phone [search]
- Empty state: No parties yet.
- API calls:
  - `GET /api/pms/parties ?{page,perPage}`

