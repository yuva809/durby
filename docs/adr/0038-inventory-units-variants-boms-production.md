# ADR 0038: Units of measurement, variants, bills of materials and production orders

- Status: accepted (2026-11-13)
- Date: 2026-11-13
- Step: inventory Step 5 (docs/modules/inventory.md → Step 5)

## Context

The Inventory sidebar gets the sub-pages a back office expects: Variant Products, Variant Attributes, Units of
Measurement, Bills of Materials and Production Order, next to Products, Product Category and Inventory Adjustment that
already exist (catalog page, Adjust tab). The reference product (docs/meroims) has variants and units but shows "Coming
soon" for bills of materials and production, so those two are our own design.

## Decisions

1. **Units are conversions at the door.** A unit of measurement is `factor` of one base unit (`kg g l ml pc`). Receipt
   lines may be entered in a unit whose base unit is the item's unit; quantity and cost are converted before booking.
   The ledger stays in the item's unit, so valuation, stock and reports are unchanged. The base unit never changes
   (receipts were converted with it); units are archived, never deleted.

2. **Variants are stock items.** A variant is an ordinary `stock_items` row with `parent_item_id` and the
   `variant_values` it was made from, so receipts, adjustments, transfers, recipes and production work on it unchanged.
   One level only. Attributes are a name and a list of values; variants copy the values (no foreign key), so editing
   or archiving an attribute never rewrites history. Menu sizes stay in Catalog.

3. **A parent with variants holds no stock.** Stock documents, recipes and bills refuse an item with active variants
   (`inventory.item_has_variants`); generating variants is refused for an item that already has movements, recipe
   lines or a bill, so nothing is stranded on it.

4. **Bills of materials are recipes for stock items.** One per item, `outputQuantity` of it takes the lines.
   Configuration like recipes (ADR 0028): replaced as a whole, deleted freely, audited. Dish recipes stay separate:
   they belong to catalog products and drive sales consumption.

5. **Production is one stock document.** `production` (`PRD-…`) moves the components out at their average cost and
   the item in at their total value ÷ quantity, in one warehouse and one transaction, under the same locking,
   negative-stock and idempotency rules as other documents. No draft or in-progress state: a correction is an
   adjustment. A workflow can be added later as a separate order table that posts this document.

6. **Keys.** Units, attributes and variants are item setup: `inventory.items.create|edit` (ADR 0037). Bills use the
   recipe keys `inventory.recipes.edit|delete`. Production gets one new location-scoped action key,
   `inventory.stock.produce`, held by admin, manager, kitchen and bar (who already receive and adjust). No custom role
   or member override needs a change.

## Consequences

- Expand-only migrations (ADR 0004); the new enum value has its own migration.
- A parent's own stock levels, if any existed before this release, stay visible but can't be moved; generating is
  refused for such items.
- Production cost is the components' value to the cent; rounding differences stay on the document (its value is the
  sum of its lines in the warehouse, close to zero).
