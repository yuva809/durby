# ADR 0053: Main warehouse, branch stores and the request cart

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0045 (branch stock requests), ADR 0048 (item categories)

## Context

The distributor (the operations menu's partner) runs one warehouse that supplies all its branches. With ADR 0045 a
branch could request only into a warehouse at its own location and had to pick which warehouse to ask; branches set up
without a warehouse could not request at all ("You can't request goods for any warehouse yet"). The request form was a
long table of quantity fields. The partner asked for one warehouse that serves every branch, and for requesting to feel
like shopping in a delivery app.

## Decisions

1. **Main warehouse.** `warehouses.is_main` (expand-only; at most one active per organization, partial unique index
   `warehouses_one_main_key`; never the transit warehouse). Set from the warehouse's edit dialog
   (`isMain` on the warehouse update) by someone holding `inventory.warehouses.edit` at every location (else 403
   `inventory.main_warehouse_not_allowed`); the previous main warehouse steps down in the same transaction, both
   audited. Archiving it ends its role.
2. **Requests come from it.** With a main warehouse, `POST /stock-requests` takes it as the source when
   `fromWarehouseId` is left out and refuses any other (400 `orders.request_main_only`). Without one, the branch names
   the source as before. Its staff already pick and pack for every branch (picking is scoped by the source location).
3. **Branch stores.** A request names the branch's warehouse (`toWarehouseId`) or the branch itself (`toLocationId`).
   A branch without an active warehouse of its own gets one, named like the branch, inside the request's transaction
   (audited `inventory.warehouse.created` by the requester); received goods are booked into it, so branches see what
   they hold. `GET /stock-requests/destinations` lists the branches the caller may request for (`orders.requests.create`
   scope), each with its warehouse or none yet; the main warehouse's own location is not a branch.
4. **The request cart** (`/requests/new`): search, category chips (the item's category, a variant its parent's; the
   availability answer now carries `categoryId` and `categoryName`), item cards with what the source has (quantities
   only, never prices), Add then − / + or a typed quantity, a sticky bar with the item count, and a side sheet to
   review, add a note and send. The cart is kept in the browser per organization and branch until sent. One menu
   item, Stock Requests, leads to it (ADR 0052).

## Consequences

- An organization without a main warehouse works as before; the source picker stays.
- A branch store is an ordinary warehouse: renamed, archived or given stock like any other.
- Choosing a main warehouse changes every branch's requests, hence the all-locations rule.
