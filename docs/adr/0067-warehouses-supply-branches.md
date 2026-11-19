# ADR 0067: A warehouse supplies the branches ticked on it

- Status: accepted (2026-11-20)
- Date: 2026-11-20
- Builds on: ADR 0053 (main warehouse), ADR 0066 (who sees a request)

## Context

Up to now, one main warehouse supplied every branch. Partners with several warehouses want each one to supply its
own set of branches: warehouse A supplies four branches, warehouse B the other three. The old dialog asked for a
"Location" and a "Main warehouse" tick, and people read the location as "the branch it supplies".

## Decisions

1. **Which branches a warehouse supplies is a list on it** (`warehouses.supplies_location_ids`, ids of locations).
   The warehouse dialog asks one question, "Which branches does it supply?", with three answers:
   - **Every branch (main warehouse)**: as before (ADR 0053); at most one.
   - **Only these branches**: tick boxes for every location except the warehouse's own.
   - **No branch**: a branch's own store, or a store room.
2. **One supplier per branch.** Ticking a branch moves it from the warehouse that supplied it; the dialog says so
   ("now from Depot"). An organization-wide lock keeps two edits from giving one branch two suppliers.
3. **Where a branch's goods come from**: the warehouse that has it ticked, else the main warehouse, else (neither
   set up) the one the branch picks, as before. Naming another source is refused (`orders.request_main_only`).
   Request destinations carry `supplierWarehouseId`, which the request cart and the branch shop use.
4. **A supplying warehouse is never a branch's store.** A branch's goods go into a non-supplying warehouse at its
   location, created with its first request as before. A branch and a depot can therefore share a location.
5. Choosing whom a warehouse supplies needs `inventory.warehouses.edit` everywhere, like the main warehouse. An
   archived warehouse supplies nobody: its branches go back to the main warehouse.

## Consequences

- Expand-only migration (an id array with a CHECK: at most 500, no NULL, none on the transit or main warehouse).
  Existing organizations behave as before, since every list starts empty.
- Warehouse staff see the requests of the warehouse they work in (ADR 0066), so each depot's staff pick for their
  branches.
- Kitchen and bar stations are hidden in the operations menu's warehouse dialog.
