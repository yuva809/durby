# ADR 0071: Branch managers see the warehouses that supply their branch

- Status: accepted
- Date: 2026-11-20
- Builds on [ADR 0057](0057-branch-and-warehouse-access.md) (what a member sees by location) and
  [ADR 0067](0067-warehouses-supply-branches.md) (which warehouse supplies a branch).

## Context

A branch manager's Inventory page listed only the warehouses at their own location. A branch whose stock comes from
the main warehouse, or from a depot elsewhere, showed "No warehouses yet", although the branch's stock requests go to
that warehouse. The branch could request from a warehouse it could not see.

## Decision

1. The warehouse list includes, for a member with locations, the warehouses at those locations **and** the warehouses
   that supply them: the main warehouse, and any warehouse ticked for one of their branches.
2. The per-member warehouse limit of ADR 0057 still applies on top: a member limited to some warehouses sees only those
   (and the transit one).
3. Seeing a supplying warehouse is a read only. Stock, receipts and changes are still checked against the warehouse's
   own location, so a branch manager cannot act on the supplier's stock through this list.

## Consequences

- No migration. The list query gets one more condition.
- Stock of a supplying warehouse may still be refused to a branch manager, as before; showing the stock is a separate
  decision.
