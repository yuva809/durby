# ADR 0074: Menu switch for Sales Orders (an organization setting)

- Status: accepted
- Date: 2026-11-20
- Builds on [ADR 0010](0010-settings.md) (settings) and [ADR 0044](0044-sales-orders.md) (Sales Orders).

## Context

An operations customer (AsiaMight) does not sell to outside customers and wants the Sales Orders item removed from its
menu. The menu layout is shared by every operations customer, and the item is shown by a feature and a permission that
also show Picking and Order History. Removing it in code for one customer would be a tenant-specific change, which the
project rules forbid.

## Decision

1. **A boolean organization setting `orders.showSalesOrders`**, default on, changed by the organization's owners on the
   Settings page like any other setting (ADR 0010).
2. **A menu item may name a setting** (`menuSetting`). It is hidden while that setting is off for the active
   organization. The sidebar reads the organization's settings and passes the switched-off keys to the menu filter.
3. **Only the menu is affected.** The page stays reachable by its address, and the api still checks its permissions.
   Stock and orders are unchanged.

## Consequences

- The change is configuration, not code: no client name appears in the code.
- Each organization decides its own menu. The setting is seen by everyone who can read settings.
- The sidebar shows Sales Orders until the settings load (the default is on), then hides it.
- The search box and other menus don't yet read this switch; they can be added the same way.
