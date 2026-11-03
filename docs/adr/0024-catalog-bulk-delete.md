# ADR 0024: Products and categories never sold may be deleted

- Status: accepted (2026-11-03); amends ADR 0016 decision 5
- Date: 2026-11-03
- Step: catalog bulk actions (docs/modules/catalog.md → Bulk actions)

## Context

ADR 0016 §5 says categories, products and tables are archived, never deleted, because orders and checks reference
them. The catalog migration enforced it by revoking `DELETE` on `product_categories`, `products` and `dining_tables`
from `durby_app`. Restaurants importing or bulk-editing a menu also need to remove mistakes (a wrong import, a test
product) that nothing ever referenced; archiving those clutters the "show archived" list for good.

## Decisions

1. **Never-sold products and categories can be deleted** through the bulk actions (`kind: 'delete'`, `action:
'delete'`) with `catalog.products.manage`. Tables stay archive-only.
2. **The database decides what was sold.** `pos_order_lines.product_id` references `products` with `ON DELETE
RESTRICT`, so deleting a sold product fails with a foreign key violation. Catalog does not read POS tables
   (rule 4): each delete runs in its own savepoint, a refused one is rolled back and reported as `kept` (reason
   `sold`). A category is deleted with its products or not at all.
3. **Grant.** An expand migration grants `DELETE` (not `TRUNCATE`) on `products` and `product_categories` to
   `durby_app`. RLS still applies. Any future table that references products or categories must keep `ON DELETE
RESTRICT`, or this decision no longer protects history.
4. **Audit.** `catalog.product.deleted` and `catalog.product_category.deleted` are recorded with the row's snapshot
   as `before`, in the delete's own transaction.

## Consequences

- Sold products and their categories can still only be archived: the history stays readable.
- Rolling back to an older release is safe: the grant is additive (ADR 0004).
