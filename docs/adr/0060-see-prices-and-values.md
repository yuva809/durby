# ADR 0060: "See prices and values": a branch sees items and quantities only

- Status: accepted (2026-11-19)
- Date: 2026-11-19
- Builds on: ADR 0045 (branch requests), ADR 0050 (permission matrix), ADR 0051 (split keys, its migration),
  ADR 0059 (the branch's view)

## Context

The distributor doesn't want its branches to see what goods cost: a branch should see what there is and how much,
nothing more. Branch managers can't read the catalog, sales orders or vendor invoices, but reading stock gave them
average costs and values (stock levels), unit costs and values (stock documents) and sale prices (items), and the
inventory page showed a Value column and a total value.

## Decisions

1. **A key, `inventory.prices.read`** ("See prices and values", matrix row Inventory → Prices and values, View),
   location scope: members limited to some locations hold only location keys, and a warehouse's staff keep prices.
   The api asks for it at any of the caller's locations, where they read stock too. Every built-in role that reads stock holds it but the Branch manager (the others can't see stock,
   so it changes nothing for them); owners can change it per role or per person in Manage Staff.
2. **The api leaves the money out** without it (null, the contract fields are nullable): `GET /inventory/stock`
   (`averageCost`, `value`), `GET /inventory/documents` (`value`), `GET /inventory/documents/:id` and the answers of
   receipts, adjustments and transfers (document `value`, line `unitCost` and `value`), items (`salePrice`). A sale
   price sent with an item by someone without it is ignored, so an edit never clears it. Audit rows and the stored
   documents keep every value. A replayed write (same idempotency key) may answer with the values it stored; only its
   own sender can replay it.
3. **The pages follow**: the inventory overview drops its Value column, total and export column ("Live stock by
   category, warehouse and stock level."), the stock tab its Average cost and Value columns and total, documents and
   production their values, the item dialog its sale price.
4. **Custom roles keep seeing prices**: a data migration (`20261119220000_inventory_prices_read`, expand only, per
   tenant under row-level security, like ADR 0051's) gives the key to every custom role, with one audit row per
   organization (`platform.permission_keys.added`, count only).

## Consequences

- The request cart, Order History and Delivery Tracking never showed prices (quantities only, ADR 0053, 0059).
- Dish costs stay behind `inventory.costs.read`; catalog prices behind `catalog.products.read`, which a branch doesn't
  hold either.
