# Route dossiers — b6-restaurant-probe

Generated from `evidence/routes/b6-restaurant-probe.json` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)
and `evidence/captures/shapes-b6-restaurant-probe.txt` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted.
Blocked write attempts in this batch: 0

## `/restaurant/till` — Till unavailable

- Headings: Till unavailable
- Actions/buttons: Retry · Back office
- API calls: (none beyond shell)

## `/restaurant/tables` — Tables & QR

- Headings: Tables & QR
- Actions/buttons: [record button]
- Form fields: Search tables or areas... [text]
- API calls:
  - `GET /api/core/branches ?{page,perPage}`
  - `GET /api/pos/restaurant/areas`
  - `GET /api/pos/restaurant/stations`
  - `GET /api/pos/restaurant/tables ?{includeInactive}`

## `/restaurant/kitchen` — Display unavailable

- Headings: Display unavailable
- Actions/buttons: Retry · Back office
- API calls: (none beyond shell)

## `/restaurant/bar` — Display unavailable

- Headings: Display unavailable
- Actions/buttons: Retry · Back office
- API calls: (none beyond shell)

## `/restaurant/waiter` — Floor unavailable

- Headings: Floor unavailable
- Actions/buttons: Retry · Back office
- API calls: (none beyond shell)

## `/till` — [tenant redacted]

- Headings: [tenant redacted]
- Actions/buttons: X-report · Cash in/out · Close shift · Scroll categories left · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · Scroll categories right · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · Previous page · Next page · W Walk-in customer tap to attach a customer attach · [record button] · Walk-in · Browse
- Tabs: All 70 · Beverages 7 · Bakery & Bread 6 · Breakfast & Cereals 6 · Canned & Preserved Goods 6 · Condiments & Sauces 6 · Frozen Foods 6 · Household & Cleaning 6 · Personal Care & Hygiene 6 · Snacks & Confectionery 6 · Spices, Oils & Seasonings 6 · Biscuits 3 · Chocolate 3 · Noodles 2 · Snacks 1
- Form fields: Scan barcode, or type a name / SKU… [text]
- API calls:
  - `GET /api/pos/products ?{registerId}`
  - `GET /api/pos/retail/context`
  - `GET /api/pos/retail/holds`

