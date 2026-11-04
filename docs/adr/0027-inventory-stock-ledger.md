# ADR 0027: Inventory stock ledger, warehouses and weighted average valuation

- Status: accepted (2026-11-04)
- Date: 2026-11-04
- Step: inventory Step 1 (docs/modules/inventory.md)

## Context

Inventory is the first sellable module. Restaurants keep ingredients and goods in several stores per location
(main store, kitchen, bar, cold room), receive deliveries at changing prices, write off waste and move stock
between stores and locations. They need to know what is there and what it is worth, and every change must be
traceable (CLAUDE.md rule 7). Recipes and sales consumption (Step 2) will write to the same ledger.

## Decisions

1. **Warehouses belong to a location**; a location has any number. Permissions are checked at the warehouse's
   location (location-scoped keys); a transfer needs the key at both locations.
2. **Stock items are organization-wide** and separate from catalog products (menu items). A recipe (Step 2) links
   a product to stock items. Units are a fixed list (`kg`, `g`, `l`, `ml`, `pc`); an item's unit is locked once it
   has movements.
3. **Documents and movements are append-only** (no UPDATE/DELETE for `durby_app`, statement triggers, the
   append-only catalog test). A correction is another document. Each document is numbered (ADR 0012), audited
   once, and completes its idempotency key in its transaction (ADR 0014).
4. **`stock_levels` is a projection**: quantity and average cost per warehouse and item, updated in the same
   transaction after locking the rows (`SELECT … FOR UPDATE`, in item order to avoid deadlocks). It can always be
   rebuilt from the movements; a test checks that it matches.
5. **Weighted average cost per warehouse and item**, 4 decimals; outgoing movements at the current average, a
   transfer carries its cost. FIFO (`inventory.valuationMethod = fifo`) needs cost layers and comes later; until
   then stock writes for such an organization answer 409 `inventory.valuation_unsupported` rather than valuing
   differently than configured.
6. **Negative stock** is refused unless `inventory.allowNegativeStock` is on at the warehouse's location. Sales
   consumption (Step 2) will be allowed to go negative regardless: a sale has already happened.

## Consequences

- Stock value is exact to the ledger; reports (Step 4) read movement values, never recompute history.
- Switching to FIFO later is data-bound (ADR 0010): only allowed before stock is recorded, as the setting says.
