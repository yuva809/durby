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

### Errors

| Code                          | Status | When                                                         |
| ----------------------------- | ------ | ------------------------------------------------------------ |
| `catalog.category_not_found`  | 404    | unknown id, another tenant's id (RLS), or a bad UUID         |
| `catalog.product_not_found`   | 404    | same for products                                            |
| `catalog.category_name_taken` | 409    | a non-archived category already has this name                |
| `catalog.product_name_taken`  | 409    | a non-archived product of the category already has this name |
| `catalog.category_archived`   | 409    | create or move a product into an archived category           |

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

`/catalog` (nav: Modules → Products, feature `catalog`, permission `catalog.products.read`). Category column and
product table; create/edit dialogs and archive/unarchive only with `catalog.products.manage`. "Show archived" toggle.
