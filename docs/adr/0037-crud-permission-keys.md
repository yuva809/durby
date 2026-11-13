# ADR 0037: Create, edit and delete permission keys

- Status: accepted (2026-11-13)
- Date: 2026-11-13
- Step: staff permissions (Manage Staff, [ADR 0023](0023-manage-staff.md))

## Context

Business modules guarded their writes with one `*.manage` key per entity (`catalog.products.manage`). It covered
creating, changing and deleting at once, so an owner who wanted a manager to edit prices but not delete products
had no way to say so. The Manage Staff matrix can only show what the keys say.

## Decisions

1. **Three keys per business entity**: `module.entity.create`, `module.entity.edit` and `module.entity.delete`,
   replacing `module.entity.manage` for: `catalog.products`, `inventory.warehouses`, `inventory.items`,
   `inventory.recipes`, `pos.tables` (tables and areas), `reservations.bookings`, `reservations.waitlist` and
   `reservations.setup`. Reads keep their `.read` key. Platform keys and action keys (`pos.orders.take`,
   `inventory.stock.receive`, …) are unchanged.

2. **Route verbs.** POST that creates (including imports, numbering and walk-ins) → `create`. PATCH, PUT, state
   changes (arrive, seat, finish, no-show, cancel, undo), menu-code rotation and every settings read or write of the
   setup module → `edit`. DELETE, archive by delete, and erasing guest data (`anonymise`) → `delete`.

3. **Bulk endpoints** (`products/bulk`, `categories/bulk`) take archive, restore or delete. The route checks `edit`;
   a delete action also requires `delete`, checked in the service.

4. **Delegated settings.** The reservations setup key that stands in for `platform.settings.manage` (ADR 0020) is
   now `reservations.setup.edit`.

5. **Retired keys keep their meaning in stored rows (expand, contract; ADR 0004).** `LEGACY_PERMISSION_ALIASES` maps
   each `*.manage` key to its three replacements. Resolution expands stored role keys and member grants and denies
   through it, so existing custom roles and overrides keep working. New writes can't use a retired key (the team API
   answers `rbac.permission_unknown`). A later release rewrites stored rows and removes the aliases.

6. **System roles.** Every new key has an explicit grant or deny in each system role, so the typecheck forces the
   decision. Admin and manager hold what they held through `manage`. Staff and the operational roles hold none.
   Owner holds all keys.

7. **Granting rules unchanged** (ADR 0007 §6, ADR 0023 §2): a member can only grant keys they hold.

## Consequences

- Route mapping is a security decision. Each route's key is listed in its controller and in the e2e tests.
- Existing data needs no migration in this release.
- Add Staff shows one row per entity with View, Create, Edit and Delete columns; a row is blank where the key does not
  exist. A module can still be ticked or cleared as a whole.
- Pages gate on the key of the action they offer where that is built. The catalog page gates all editing on
  `catalog.products.edit`; hiding its "New product" button for `create`-less members is a follow-up.
