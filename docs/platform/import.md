# Import Data

- Code: `packages/shared/src/api/imports.ts`, `apps/web/components/imports/`, `apps/web/lib/imports/`, and one service
  per owning module (`catalog/category-import.service.ts`, `inventory/item-import.service.ts`,
  `StockService.importOpeningStock`, `CustomersService.importCustomers`)
- Decisions: [ADR 0044](../adr/0044-operations-menu-orders-fulfilment.md) step 4,
  [ADR 0054](../adr/0054-vendor-invoice-approval-and-import-data.md) (Excel, page layout, vendor invoice tile)

A CSV and Excel wizard (`/import`, Tools & utilities in the operations menu) to bring existing lists into the app. The
browser reads the file and sends rows as JSON to the module that owns the records; the module checks them again and writes
**all rows in one transaction, or none**.

## Kinds

| Kind          | Endpoint                                      | Key                       | Matches existing by                       | Writes                                             |
| ------------- | --------------------------------------------- | ------------------------- | ----------------------------------------- | -------------------------------------------------- |
| Categories    | `POST /api/v1/catalog/categories/import`      | `catalog.products.create` | name (case-insensitive)                   | new categories at the end of the menu order        |
| Stock items   | `POST /api/v1/inventory/items/import`         | `inventory.items.create`  | SKU if given, else name                   | creates; updates need `inventory.items.edit` too   |
| Opening stock | `POST /api/v1/inventory/opening-stock/import` | `inventory.stock.receive` | warehouse by name; item by SKU, else name | one goods receipt per warehouse at the given costs |
| Customers     | `POST /api/v1/orders/customers/import`        | `orders.customers.create` | code if given, else name                  | creates; updates need `orders.customers.edit` too  |

There is no separate import key: each kind needs the key of its module (the plan's `platform.import.run` was
dropped, ADR 0044). The page and its menu item show the kinds the user may run.

- Body `{ rows: [...] }`, 1–5,000 rows; every cell a string (empty = not given; on update, empty keeps the value).
- `@Idempotent({ completion: 'transaction' })`: a replay with the same key returns the stored result.
- Answer `{ created, updated, unchanged, documents }` (`documents`: receipt numbers for opening stock).
- Refused as a whole with `catalog.import_invalid`, `inventory.import_invalid` or `orders.import_invalid` and
  `details.rows: [{ row, field, problem }]` (`required`, `too_long`, `invalid`, `duplicate`, `unknown`).
- Every created or changed record gets its usual audit row (customers without contact details).

## Templates (CSV header row)

| Kind          | Columns                                     | Required                        |
| ------------- | ------------------------------------------- | ------------------------------- |
| Categories    | `name`                                      | `name`                          |
| Stock items   | `name, sku, unit, min_quantity, sale_price` | `name, unit` (kg, g, l, ml, pc) |
| Opening stock | `warehouse, item, quantity, unit_cost`      | all                             |
| Customers     | `name, code, phone, email, address, note`   | `name`                          |

Headers match loosely (case, spaces and `_` ignored) with a few aliases (`price` → sale price, `qty` → quantity,
`mobile` → phone, …). Comma or semicolon separated, UTF-8 with or without BOM, decimal commas (`8,50`) accepted.

Excel: `.xlsx` workbooks are read on the device (`readXlsxRows`, `read-excel-file`), from the sheet named like the kind
("Items", "Opening stock") or else the first; numbers as the text Excel stored (no float noise). CSV and Excel both go
through `readTableRows`. Other files (`.xls`, `.ods`, …) are refused: save as `.xlsx` or CSV. The template downloads
as CSV with a BOM, which Excel opens directly.

## Web

A header ("Bring your existing data in", three steps), then a tile per kind the person may import (icon, description,
"CSV · Excel") and, for those with `inventory.stock.receive`, the vendor invoice tile ("PDF · Photos") with a link to
the approval queue ([inventory.md → Vendor invoices](../modules/inventory.md)).

Pick the kind → download its template → choose a CSV or Excel file → the preview shows the row count, the first 10 rows and
every problem (`checkCategoryRows`, `checkItemRows`, `checkOpeningStockRows` with the loaded warehouses and items,
`checkCustomerRows`; the same checks the api runs) → "Import N rows" (disabled while there are problems) → summary.

## Tests

- Web: `components/imports/import-page.test.tsx`, `lib/imports/table.test.ts`.
- API e2e (Docker): `test/data-import.e2e.spec.ts` (each kind, all-or-nothing, unknown warehouses, keys, replay).
