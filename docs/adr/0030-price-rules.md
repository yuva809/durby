# ADR 0030: Prices per location and time (price rules)

- Status: accepted (2026-11-05)
- Date: 2026-11-05
- Step: inventory Step 3 (docs/modules/inventory.md, docs/modules/catalog.md → Price rules)

## Context

A product had one price, copied onto the order line when it is sent. Owners with several locations charge
differently per location, and run happy hours and promotions. Margins (ADR 0028) must use the price a
location really charges.

## Decisions

1. **Price rules** (`price_rules`, catalog): a name, a location or all locations, a target (one product, or
   one category), a kind (`fixed` price, or `percent_off`, categories only), a value, and optional weekdays,
   hours (`HH:mm`–`HH:mm`, past midnight allowed: it belongs to the day it starts) and dates (inclusive),
   plus `active`. Rules are configuration: changed and deleted freely, every change audited. Managing them
   needs `catalog.products.manage`, reading `catalog.products.read`.
2. **Resolution** (`resolvePrice` in `packages/shared`, the same code in the api and the web):
   the regular price is the most specific rule without days, hours or dates, else the product's price; a
   matching time rule applies on top of it (`fixed` replaces, `percent_off` takes off, half up to the
   cent). Specificity: product here > product everywhere > category here > category everywhere. Equally
   specific rules: the lower price wins. Money is computed in integer cents (BigInt), never floats.
3. **Local time** is the location's `timezone` setting at the moment of sending.
4. **The api decides** the charged price: `sendTicket` asks `CatalogService` for orderable products priced
   at the table's location and the current time, in its own transaction (ADR 0021). The order screen and the
   guest QR menu show the same resolution; voids keep the price the line was charged. This also moves
   pos's product read behind catalog's public service (CLAUDE.md rule 4).
5. Margins on the Menu page use the regular price of the chosen location (`/catalog/prices?timed=false`).

## Consequences

- An order line's `unitPrice` is the price after rules; reports (Step 4) read it as before.
- Overlapping equally specific rules are allowed; the price check in the web shows which rule wins.
- Bundles, per-guest discounts and "buy 2 get 1" are out of scope.
