# ADR 0057: Branch Access and Warehouse Access for staff

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0023 (Manage Staff), ADR 0045 (branch stock requests), ADR 0053 (main warehouse), ADR 0056 (Branches)

## Context

The distributor (the operations menu's partner) runs several warehouses at one location (a dry store and a cold room
at the main warehouse) and wants some staff to work only in some of them. Locations were the finest scope a member
could have. Its staff dialog should also ask "which branches" as plain ticks, nothing ticked meaning every branch.

## Decisions

1. **`memberships.warehouse_ids uuid[]`** (expand-only, default empty, at most 500, no NULLs). Empty: every warehouse
   at the member's locations (as before). With ids: only those, for warehouse work. Owners are never limited. An array
   column, not a join table: a new model pushed the Prisma client's types past TypeScript's depth limit; warehouses are
   archived, never deleted, so the missing foreign key loses nothing the service doesn't check.
2. **One check** (`holdsAtWarehouse`, `AccessService.canAtWarehouse/assertAtWarehouse/warehouseIds`): the key at the
   warehouse's location, and the warehouse among the member's when they are limited. Used for: stock levels,
   documents and movements; receipts, adjustments, transfers and production; the warehouse list (the transit warehouse
   stays visible: it is everybody's road between warehouses, and moving goods into it is decided by its location);
   opening stock import; vendor invoices (list, submit, correct, approve, reject); low-stock counts; a sales order's
   warehouse; branch requests: picking and packing at the source warehouse, receiving into the branch's, and the
   request list (requests out of or into the member's warehouses). Reading a branch's request stays by location.
3. **Manage Staff** (`warehouseIds` on create and update, null or empty = every warehouse; on each member). Each id must
   be an active warehouse other than the transit one, at one of the member's locations (`rbac.warehouse_invalid`),
   checked through the `WAREHOUSE_DIRECTORY` port the inventory module provides (platform code reads no module
   tables). A member's locations changing re-checks the warehouses they keep. Granting: someone limited to some
   warehouses gives only some of theirs, never "every warehouse" (`rbac.not_grantable`); what the member already has
   may stay. Audited in the membership snapshot. Invitations take no warehouses: set them once the person has joined.
4. **Web, operations menu only** (AsiaMight; elsewhere the dialog is unchanged): "Branch Access" as ticks (none =
   every branch) and "Warehouse Access" as ticks grouped by branch (only the chosen branches' warehouses; none = every
   warehouse at their branches).

## Consequences

- Nobody loses access: every existing membership has no warehouses, which means every warehouse at its locations.
- A member limited to a warehouse no longer sees the others' stock, even at the same location.
