# ADR 0043: Renumber the menu 1…N

- Status: accepted (2026-11-14)
- Date: 2026-11-14
- Amends: ADR 0029 (menu numbers)

## Context

Menu numbers (ADR 0029) are free text per product, set by hand, by import or scan, or by "Fill missing numbers",
which only numbers products without one and continues above the highest number in use (after a scanned `105`, new
dishes get `106`, `107`). Customers want plain `1, 2, 3 …` across the menu, for every organization.

## Decisions

1. **Renumber menu.** A new action, `POST /catalog/products/renumber`, gives every non-archived product `1…N` in
   menu order (category position and name, then product position and name): the same order as "Fill missing
   numbers". It replaces existing numbers, letters included. Archived products keep theirs (they are outside the
   unique index).
2. **Key `catalog.products.edit`**: it changes existing products (ADR 0037 route verbs), unlike filling numbers
   (`create`).
3. **Safe swaps.** Only products whose number changes are written: they are cleared first, then numbered, in one
   transaction, so `1` and `4` can trade places without a unique violation. Each change is an ordinary
   `catalog.product.updated` audit entry. The response (`{ renumbered }`) is stored with the idempotency key.
4. **Explicit.** No automatic renumbering on create or reorder: printed menus and what staff type at the till would
   change unannounced. The web asks for confirmation and says so.
5. **Drag-and-drop category order.** `POST /catalog/categories/order` saves the order editors drag (positions
   `0, 10, 20 …`, one transaction, changed ones audited); Renumber menu then follows it. `@Idempotent()`: it sets
   positions, so a replay writes the same order.
6. **Product table by number.** The catalog page lists products by menu number (1, 2, 3 …, then letter codes, then
   unnumbered), so the list matches what staff type at the till.

## Consequences

- After adding or moving dishes, an owner can renumber again to close gaps; numbers then follow the menu order.
- Price rules, recipes and orders refer to products by id, so nothing else changes.
