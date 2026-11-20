# ADR 0049: Variants, modifiers, sold-out (86) and product pictures

- Status: accepted for product pictures (step 1); variants, modifiers and sold-out accepted, built in later steps
- Date: 2026-11-20
- Step: menu and venue setup (tracker group "L2 Menu & venue setup → Menu & products"). Builds on
  [ADR 0030](0030-price-rules.md) (prices), [ADR 0037](0037-crud-permission-keys.md) (write keys) and
  [ADR 0048](0048-inventory-categories-and-overview.md) (category tile images, reused for products).

## Context

Restaurants sell sizes (Small, Large), add-ons with choices (Extras, Sauce), run out of items during service and
want a picture of each product on the QR menu and a future kiosk. None of these exists. The till sells one price per
product, notes are free text, there is no availability switch and no product picture.

## Decisions

1. **Product pictures (built first).** One picture per product in `product_images`, the category tile pattern:
   the browser resizes to WebP/PNG/JPEG of at most 300 KB, the api checks the first bytes, the picture is stored
   apart from the product row so lists stay light and is read back with the token. Writes use `catalog.products.edit`
   (ADR 0037), reads `catalog.products.read`. Each change is audited as `catalog.product.updated`; the picture's bytes
   are never in an audit row. `imageVersion` on a product is the cache key of its picture's url.

2. **Variants (later step).** A product has zero or more variants (`product_variants`): a name, a gross price and a VAT
   rate. A product without variants sells at its own price, as today. A product with variants sells only a variant.
   An order line stores the variant and snapshots its name, price and rate (`pos_order_lines.variant_id`, nullable,
   expand-only).

3. **Modifiers (later step).** Groups (`modifier_groups`: required, min and max choices) hold options
   (`modifier_options`: a gross price delta, may be 0), linked to products (`product_modifier_groups`). A line stores
   its chosen options as snapshots (`pos_order_line_modifiers`, append-only). A line's price is (variant or product
   price + the deltas) × quantity. A required group needs at least its minimum, and no group takes more than its
   maximum; the api refuses otherwise.

4. **Sold-out, 86 (later step).** `sold_out_marks` is append-only per location and product: a mark, and a restore
   that carries `cleared_at`. A product is sold out at a location when its latest mark is not cleared and was made on
   the location's current business day (automatic reset at the start of the next day). The till and the QR menu hide
   it, and ordering a sold-out product is refused with `pos.product_sold_out`.

5. **Expand only.** New tables and nullable columns; nothing dropped or renamed. Older images keep working.

## Consequences

- A picture is public only through the authenticated api; the QR menu and kiosk get their own read route in the QR
  step (not in this change).
- Snapshots mean a later menu edit never changes a past order or bill (as for names and prices today).
- Variant recipes and per-variant stock are not part of this decision; recipes stay per product.
