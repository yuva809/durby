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

**File formats** (web app): **CSV** or **Excel `.xlsx`** (the sheet named `products`, else the first sheet; read
in the browser with `read-excel-file`, loaded only for `.xlsx`; numbers taken as Excel stored them, float noise
rounded away by text, a VAT cell in percent format such as `0.07` read as `7`). Both have a header row with `category`, `name`, `price`, `tax_rate` and optionally `description`
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

### Menu scan (`/catalog/scan`)

Builds products from the menu a restaurant already has — photos or a PDF — and imports them through the same
`POST /catalog/products/import` (all or nothing, update-or-create, audit). Only with `catalog.products.manage`.
**No api of its own:** reading and review happen in the browser.

1. **Upload** any image the browser decodes (JPG, PNG, WebP, GIF, AVIF…; HEIC only in Safari, elsewhere a hint to
   export JPG) or PDF; camera on phones and tablets; paste with Ctrl+V. Up to 10 photos or image-only pages per scan
   (each takes OCR) and PDFs up to 60 pages.
2. **Read**, entirely in the browser:
   - **PDFs that carry their text** (most menus exported from a design tool) are read **exactly** from the PDF
     (`pdf-text.ts`, pure): no OCR. The layout says what each run of text is: the largest or sideways text is the
     page's category (a page without one continues the previous), text in the size of the dish names (the type on
     the item numbers' rows) starts an item and continues it on the next line, smaller text below is its
     description, prices are matched to the item on their row, volumes (`0,4l`, `4cl`) become part of the name, a
     volume header over a second price column makes a second product (`… 0,2l` / `… 0,4l`), and tiny marks
     (allergen codes) are left out. Names, descriptions and prices are exactly as printed; no word corrections are
     suggested for them.
   - **Photos and image-only PDF pages** go through Tesseract (English and German) in a web worker. Each image is
     scaled, reduced to its darkest colour channel, the paper flattened (its brightness estimated block by block and
     divided out, so coloured panels, shadows and uneven light become white), long vertical rules erased and the
     levels stretched (`image.ts`). The page is cut into column strips at gutters and each strip read on its own, so
     side-by-side columns don't mix; prices read apart from their names are joined back by row.
     **Images never leave the device**; the OCR engine and its language data load from jsDelivr on first use and are
     cached by the browser.
3. **Parse** (`lib/catalog/menu-scan/parse.ts`, pure): OCR lines that run across menu columns are split at wide
   word gaps (never in front of a price, so a name keeps its far-right price) and read column by column, top to
   bottom; then a line ending in a price is a product (dot leaders, item
   numbers and currency marks such as `€`, `Rs`, `LKR` removed; `1,500.00`, `1.500,00`, `12,50`, `12` become
   decimal text without number math, rule 6); a short unpriced line before priced ones is a category heading;
   unpriced lines under a product that are smaller than product lines or start lowercase are its description;
   a heading starts uppercase and is at least as tall as product lines; item numbers glued to names (`67.Naan`)
   and junk after a price are removed; a second price on a line is kept in the description.
4. **Review board:** the page image with the OCR boxes beside a board of category columns. Drag products between
   categories and within one, drag categories to reorder (pointer, touch and keyboard); rename, merge, swap and
   delete categories (products of a deleted one go to "Uncategorized"); VAT per category, pre-filled from two
   defaults (drink-like category names get the drinks rate); edit, add, delete and bulk-move products; undo/redo;
   low OCR confidence is highlighted; each product shows **New** or **Updates** (same matching as the import);
   problems from `checkImportRows` block the import. The draft survives a reload (this browser only).
5. **Suggestions** (`lib/catalog/menu-scan/suggest.ts`, pure, no network): misread words are corrected against a
   built-in menu vocabulary plus the organization's own product and category names (edit distance with OCR
   confusions such as `l/t`, `rn/m`, `U/V`); a name close to an existing product suggests that product's exact
   name (so the import updates it); products in "Uncategorized" or under a doubtful heading get a category
   suggestion from dish keywords (breads, desserts, drinks…). Each suggestion is a chip on the card (apply or
   dismiss); "Apply all" is one undo step. Any edit marks a product as checked.
6. **Import** → the usual summary.
