# ADR 0068: A warehouse gets a place of its own

- Status: accepted (2026-11-20)
- Date: 2026-11-20
- Builds on: ADR 0057 (warehouse access), ADR 0067 (warehouses supply branches)

## Context

The Add Warehouse dialog asked for a "Location", filled from the branches. People read it as "which branch", and a
main warehouse ended up at a shop's location. With ADR 0067 the dialog already asks which branches a warehouse
supplies; where it physically is only matters to the app.

## Decisions

1. **No location in the dialog.** A warehouse added without `locationId` gets a location of its own, named like it
   ("North Depot", or "North Depot (2)" when the name is taken), flagged `locations.is_warehouse_site`. Renaming the
   warehouse renames its place when the name is free. The API still takes `locationId` for other callers.
2. **A warehouse's place is no branch**: it is left out of the Branches page, the request destinations, the "Only
   these branches" tick boxes and Branch Access. Warehouse workers are limited to it through Warehouse Access
   (ADR 0057).
3. Creating one needs `inventory.warehouses.create` everywhere, since a new place is in nobody's location list.

## Consequences

- Expand-only migration (`locations.is_warehouse_site`, default false). Existing warehouses keep their locations.
- `platform/organization` exports `createWarehouseSite` and `renameWarehouseSite` for inventory (module → platform).
