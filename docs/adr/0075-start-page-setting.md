# ADR 0075: Start page setting (Overview or Inventory)

- Status: accepted
- Date: 2026-11-20
- Builds on [ADR 0010](0010-settings.md) (settings) and [ADR 0074](0074-menu-switch-for-sales-orders.md) (the menu switch).

## Context

An operations customer wants people to land on Inventory after sign-in, and no Overview item in the menu. Overview is a
placeholder until the module dashboards exist. Removing it for one customer in code would name that customer in the
code, which the project rules forbid.

## Decision

1. **An organization setting `startPage`** with the values `overview` (default) and `inventory`, changed by the owner
   on the Settings page like any other setting (ADR 0010).
2. **With `inventory`:** the Overview menu item is not shown, and the signed-in home page sends the person to
   Inventory. Drivers still go to their deliveries first, as before.
3. **Nothing else changes.** Overview still exists as a page, and the setting is per organization.

## Consequences

- The change is configuration, not code: no customer's name appears in the code.
- A person who may not read stock still lands on Inventory, which shows the usual "no access" message. A later change
  can send such people to their first permitted page.
