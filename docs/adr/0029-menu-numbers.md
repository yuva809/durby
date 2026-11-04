# ADR 0029: Menu numbers and ordering by number

- Status: accepted (2026-11-04)
- Date: 2026-11-04

## Context

Many restaurant menus number their dishes ("12 Butter Chicken"). Waiters take orders by these numbers and
want to type them on the till instead of searching names. Products had no number, and the menu scan threw the
printed numbers away. Separately, scanned and imported menus created every category on the kitchen station,
so drinks never printed at the bar.

## Decisions

1. **A product has an optional menu number** (`products.menu_number`): 1–6 characters, letters, digits, `.`
   and `-`, starting with a letter or digit (`12`, `12a`, `D4`, `B-3`). It is configuration, set by the
   menu's owner; it is **not** a number series (ADR 0012 is for document numbers that only move forward).
2. **Unique per organization among non-archived products, case-insensitively** (partial unique index on
   `(tenant_id, lower(menu_number))`): typing a number must find one dish. Archiving frees the number.
3. Numbers come from the product dialog, the CSV import's optional `number` column, the menu scan (the number
   printed before the dish) and **Fill missing numbers** (`POST /catalog/products/number`), which gives every
   unnumbered product the next integer above the highest numeric one in use, in menu order. An import row
   without a number leaves the product's number alone.
4. **Order screen:** the search matches numbers exactly and names by substring; an exact number match is
   listed first and Enter adds it to the cart. Printed bills and tickets don't show numbers (not asked for).
5. **Import rows may carry a station**, used only when the import creates the category; the menu scan sends
   `bar` for drink sections. Existing categories keep their station.

## Consequences

- One more audited product field (`menuNumber` in the snapshot allow-list).
- Restaurants numbering per section with repeated numbers ("Starters 1", "Mains 1") must use prefixes
  (`S1`, `M1`); per-section numbering was not asked for.
