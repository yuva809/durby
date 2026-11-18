# ADR 0051: Split broad manage/edit keys

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: [ADR 0007](0007-rbac.md), [ADR 0023](0023-manage-staff.md), [ADR 0037](0037-crud-permission-keys.md) §5,
  [ADR 0050](0050-staff-matrix-placement.md)
- Cleanup release: [#126](https://github.com/yuva809/durby/issues/126)

## Context

ADR 0050 put every key in one View / Create / Edit / Delete cell, but four boxes allowed more than their column said
(they carried an info note), and the Organization row had no View box:

- `platform.users.manage` changed **and** removed members;
- `platform.roles.manage` created, edited **and** deleted roles;
- `orders.orders.edit` edited, confirmed **and** cancelled sales orders;
- `orders.customers.edit` edited **and** archived customers.

## Decisions

1. **New keys.**

   | Old key                 | Replaced by / joined by                                      |
   | ----------------------- | ------------------------------------------------------------ |
   | `platform.roles.manage` | `platform.roles.create`, `.edit`, `.delete` (retired)        |
   | `platform.users.manage` | `platform.users.edit`, `.delete` (retired; invite stays)     |
   | `orders.orders.edit`    | stays; `orders.orders.delete` added (cancel)                 |
   | `orders.customers.edit` | stays; `orders.customers.delete` added (archive and restore) |
   | —                       | `platform.org.read` added (Organization → View)              |

   Organization and Settings stay View + Edit: no create or delete keys.

2. **Routes.**

   | Route                                                              | Key                                           |
   | ------------------------------------------------------------------ | --------------------------------------------- |
   | `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`             | `platform.roles.create`, `.edit`, `.delete`   |
   | `PATCH /members/:id`, `PATCH /staff/:id`                           | `platform.users.edit`                         |
   | `DELETE /members/:id`, `POST /staff/:id/deactivate`, `/reactivate` | `platform.users.delete`                       |
   | `POST /orders/:id/cancel` (route and service)                      | `orders.orders.delete`                        |
   | `PATCH /orders/customers/:id` with `archived` changed              | `orders.customers.edit` + `.delete` (service) |

   Deactivating takes access away like removing, so it is the Delete box; reactivating is its undo. The "sales order
   returned" notification and the attention count stay on `orders.orders.edit`. Safety rules are unchanged: nobody
   changes or removes themselves, the last owner or a system role, and the subset rule applies.

3. **`platform.org.read`.** Before this ADR every member saw the organization (its name comes in the session, the
   Company tab had no key); private organization data (address, tax id) isn't stored yet. So the key has
   **location scope** (a member limited to some locations holds it too), **every built-in role** holds it and the
   migration gives it to **every custom role**. It gates the Company settings tab only; the session keeps the name
   for everyone (the organization switcher needs it). It is the key for private organization data once that exists.

4. **System roles.** In `SYSTEM_ROLE_GRANTS` each old key is replaced by all of its new keys in every role that had
   it, so no built-in role gains or loses anything (a test checks each role holds a split key whole).

5. **Stored rows: expand now, contract later (ADR 0004, ADR 0037 §5).**

   - `LEGACY_PERMISSION_ALIASES` maps `platform.roles.manage` and `platform.users.manage` to their new keys, so a
     stored old key keeps its full meaning. The team and roles APIs refuse the retired keys for new writes.
   - The migration `20261118150000_split_broad_permission_keys` adds, per tenant with `app.tenant_id` set, a row with
     the same effect on each new key for every stored old key in `role_permissions`, `membership_permissions` and
     `invitation_permissions`, plus `platform.org.read` for every custom role. It only inserts
     (`ON CONFLICT DO NOTHING`), so running it again changes nothing, and it **keeps the old rows** so the previous
     release still works after a rollback. One audit row per organization that got rows
     (`platform.permission_keys.split`, actor `migration`, the count only).
   - Saving a role or a member replaces its whole key set, so old rows also disappear on the next save.
   - The cleanup release ([#126](https://github.com/yuva809/durby/issues/126)) deletes the old rows and the two aliases.

6. **Dry run.** `pnpm --filter @durby/api rbac:split --dry-run` reads every organization and prints each custom role,
   member and open invitation the migration gives rows, the rows, and whether its effective permissions stay the same
   (stored keys read with their pre-split meaning before, the migrated rows without aliases after). It exits 1 if
   anything would change. After the deploy it prints no rows. It prints ids and role names, never emails.

7. **Granting rules see what members can do.** `RolesService.viewOf` now expands stored legacy keys like access
   resolution does (`storedRoleKeys`), so the subset rule compares a role by what its members can really do. Before,
   a custom role still holding an ADR 0037 `*.manage` key looked smaller to the subset rule than it was.

8. **Matrix.** Members get Edit and Delete boxes, Roles Create, Edit and Delete, Organization a View box, Sales
   orders and Customers a Delete box. The four info notes are gone; the `note` field stays for future keys.

## Consequences

- No access changes on deploy: tests check every built-in role, mixed grant/deny fixtures and the migration on
  prepared data (lossless, idempotent), and that a legacy-key holder gets the same subset-rule verdicts as before.
- Per-route tests: a member with only one new key gets its route and 403 on the siblings.
- The web hides each action behind its own key (New role, edit and delete role; change, remove, deactivate member;
  cancel sales order; archive and restore customer; Company tab).
- Until #126 ships, the stored old rows and the two aliases stay.
