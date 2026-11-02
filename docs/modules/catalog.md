# Catalog module

Products a restaurant sells, grouped into categories. Used by table service now (`pos`, waiter orders in step 3) and
by inventory and billing later. Code: `apps/api/src/modules/catalog/`. Decisions: [ADR 0016](../adr/0016-table-service-before-tse.md).

## Entities

```
Organization (tenant)
 └─ ProductCategory   product_categories   tenant table (RLS)
     └─ Product       products             tenant table (RLS)
```

| Table                | Columns                                                                                                                                          | Notes                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `product_categories` | `id`, `tenant_id`, `name`, `sort_order`, `archived_at`, timestamps                                                                               | Name trimmed 1–100, unique per tenant among non-archived categories                              |
| `products`           | `id`, `tenant_id`, `category_id`, `name`, `description`, `price numeric(12,2)`, `tax_rate numeric(5,2)`, `sort_order`, `archived_at`, timestamps | `(tenant_id, category_id)` → categories, `RESTRICT`. Name unique per category among non-archived |

- ADR 0005 throughout: `UNIQUE (tenant_id, id)`, composite tenant FKs, `ENABLE` + `FORCE ROW LEVEL SECURITY`, `tenant_isolation`.
- **Money** (rule 6): `price` is gross (VAT included, as menus show it) in the organization's currency
  (`platform.currency` setting), `numeric(12,2)`, `>= 0`. `tax_rate` is a percentage `numeric(5,2)` in `[0, 100]`
  (e.g. `7.00` food, `19.00` drinks in Germany). JSON carries both as strings: `"12.50"`, `"7.00"`.
- **Archive, never delete.** Orders and guest checks (steps 3–4) reference products; an archived product or
  category is hidden from ordering and from default lists but stays readable. Unarchiving checks name uniqueness again.
- A product can't be put into an archived category; archiving a category leaves its products as they are (the
  ordering screen hides products of archived categories).

## Feature and permissions

Feature `catalog` (no dependencies, no limits), in every seeded plan (migration `…_catalog_and_tables`).

| Key                       | Scope        | Grants                                        | admin | manager | staff |
| ------------------------- | ------------ | --------------------------------------------- | ----- | ------- | ----- |
| `catalog.products.read`   | location     | list categories and products                  | ✓     | ✓       | ✓     |
| `catalog.products.manage` | organization | create, edit, archive categories and products | ✓     |         |       |

`catalog.products.read` is location-scoped only so location-limited members (waiters, step 2) can hold it: the
catalog itself is organization-wide.

## API (`/api/v1`, `@RequireFeature('catalog')`)

| Method + path                   | Permission                | Idempotency                 | Body / query                                                     |
| ------------------------------- | ------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `GET /catalog/categories`       | `catalog.products.read`   |                             | `?includeArchived=true`                                          |
| `POST /catalog/categories`      | `catalog.products.manage` | `completion: 'transaction'` | `{ name, sortOrder? }`                                           |
| `PATCH /catalog/categories/:id` | `catalog.products.manage` | response                    | `{ name?, sortOrder?, archived? }`                               |
| `GET /catalog/products`         | `catalog.products.read`   |                             | `?categoryId=&includeArchived=true`                              |
| `POST /catalog/products`        | `catalog.products.manage` | `completion: 'transaction'` | `{ categoryId, name, description?, price, taxRate, sortOrder? }` |
| `PATCH /catalog/products/:id`   | `catalog.products.manage` | response                    | any of the create fields, `archived?`                            |

Lists are ordered by `sort_order`, then name, then id. Responses carry `archivedAt` (ISO or `null`).

### Import (`POST /catalog/products/import`)

`catalog.products.manage`, `completion: 'transaction'` (it appends). The web app reads a CSV file in the browser
and sends its rows; the api never sees the file.

- **Body** `{ rows: [{ category, name, price, taxRate, description? }] }`, 1–1000 rows, strings as in the file
  (`price`/`taxRate` with a dot; the web app turns `4,50` into `4.50`).
- **All or nothing.** Every row is checked first: category and name trimmed 1–100, price and VAT rate as for a
  single product, description ≤ 500, no category + name twice in the file (case-insensitive). Any problem → 400
  `catalog.import_invalid`, `details.rows: [{ row, field, problem }]` (`row` = 1-based data row; `problem` one of
  `required`, `too_long`, `invalid`, `duplicate`). Nothing is written.
- **One transaction:** a category is matched by name among non-archived categories, case-insensitive, and created
  when missing; a product is matched by category + name among the category's non-archived products. A match whose
  price, VAT rate or description differ is **updated**; otherwise **unchanged**; no match is **created**.
  Products missing from the file and archived products are never touched.
- **Response** `{ created, updated, unchanged, categoriesCreated, rows: [{ row, status, productId }] }`
  (`status`: `created`, `updated`, `unchanged`), stored with the idempotency key (a replay returns it).
- Audit: the usual `catalog.product_category.created`, `catalog.product.created` and `catalog.product.updated`
  rows, one per change, in the same transaction.

**CSV format** (web app): a header row with `category`, `name`, `price`, `tax_rate` and optionally `description`
(any order, any case; `vat` is accepted for `tax_rate`), comma- or semicolon-separated (German Excel uses
semicolons), quotes per RFC 4180, UTF-8 with or without BOM. The import dialog offers this header as a template. Samples with example rows: [`docs/samples/products-import-template.xlsx`](../samples/products-import-template.xlsx)
(fill in, then _Save As → CSV UTF-8_) and [`docs/samples/products-import-sample.csv`](../samples/products-import-sample.csv)
(ready to import).

### Errors

| Code                          | Status | When                                                         |
| ----------------------------- | ------ | ------------------------------------------------------------ |
| `catalog.category_not_found`  | 404    | unknown id, another tenant's id (RLS), or a bad UUID         |
| `catalog.product_not_found`   | 404    | same for products                                            |
| `catalog.category_name_taken` | 409    | a non-archived category already has this name                |
| `catalog.product_name_taken`  | 409    | a non-archived product of the category already has this name |
| `catalog.category_archived`   | 409    | create or move a product into an archived category           |
| `catalog.import_invalid`      | 400    | an import row is invalid (`details.rows`)                    |

Labels: `catalog.errors.<camelCase>`.

## Audit

| Action                             | Entity             | Snapshot fields                                                           |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `catalog.product_category.created` | `product_category` | `id`, `name`, `sortOrder`, `archivedAt`                                   |
| `catalog.product_category.updated` | `product_category` | same (also archive / unarchive)                                           |
| `catalog.product.created`          | `product`          | `id`, `categoryId`, `name`, `price`, `taxRate`, `sortOrder`, `archivedAt` |
| `catalog.product.updated`          | `product`          | same (also archive / unarchive)                                           |

`description` is free text and stays out of snapshots. A `PATCH` that changes nothing writes no audit row.

## Events

None yet: no other module consumes catalog changes. Inventory (later) adds `catalog.product.*` events when it needs them.

## Web

**Import CSV** (with `catalog.products.manage`): download the template, choose a file, check the preview (rows
and problems by row number), import, read the summary (created / updated / unchanged / new categories).

`/catalog` (nav: Modules → Products, feature `catalog`, permission `catalog.products.read`). Category column and
product table; create/edit dialogs and archive/unarchive only with `catalog.products.manage`. "Show archived" toggle.
