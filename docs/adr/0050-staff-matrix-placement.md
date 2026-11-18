# ADR 0050: Every permission in one cell of the Manage Staff matrix

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0023 (Manage Staff), ADR 0037 (create, edit and delete keys)

## Context

ADR 0037 gave Add/Edit Staff View, Create, Edit and Delete columns, but only for keys named `.read`, `.create`, `.edit`
or `.delete`. The other 31 keys (`pos.orders.take`, `orders.picking.use`, `platform.users.manage`, …) were listed
as sentences under their area, so the matrix was half grid, half list. Owners asked for every permission in the grid.

## Decisions

1. **The registry owns the placement.** Every `PERMISSIONS` entry has a required `matrix: { row, column, note? }`.
   `row` is `<module>.<row>`, `column` is one of `read | create | edit | delete` (`MATRIX_COLUMNS`). The typecheck
   fails for a key without one; a test fails when two keys share a row and column, or a row holds another module's
   key.
2. **One key per cell.** Job verbs that would collide get their own short-named row instead of sharing a cell:
   stock receive/adjust/transfer/produce are the Deliveries, Stock adjustments, Stock transfers and Production rows;
   `pos.orders.discount` is Discounts & comps; request approve/receive and delivery assign are their own rows.
3. **Column choice.** The column says what the box mainly does: `take` → Create, `close` → Edit, `void` → Delete,
   `invite` → Create, `bills.print` → Create, `bills.cancel` → Delete, every `.use` key (kitchen, bar, picking,
   delivery) → Edit, `*.manage` → Edit.
4. **No invented keys.** A cell without a key shows a muted dash. The matrix never makes up a key the api doesn't
   check; filling the gaps is a key change with its own ADR. Planned next: `platform.roles.manage` →
   `roles.create/edit/delete`, `platform.users.manage` → `users.edit/delete`, a `platform.org.read` View key, and
   delete keys for sales orders (cancel) and customers (archive). Organization and Settings stay View + Edit only.
5. **Honesty for broad keys.** Where a box allows more than its column says, its placement has a `note` label
   (`<module>.permissionNotes.*`), shown as an info marker and read out with the box's name:
   `platform.users.manage` (also removes members), `platform.roles.manage` (also creates and deletes roles),
   `orders.orders.edit` (also cancels), `orders.customers.edit` (also archives). A note goes when its key is split.
6. **Layout.** Sections per module in registry order (platform first, named "Administration"; the others by their
   feature name), each with a tri-state box; rows with a whole-row box; the full sentence stays the box's title and
   accessible name. Row names are `<module>.permissionRows.<row>` labels.
7. **Layout only.** Keys, scopes, routes, guards, system roles and what the dialog saves are unchanged (a test checks
   the saved overrides per system role). No role filtering: an owner can still grant beyond the role (ADR 0023).

## Consequences

- A new permission key needs a matrix cell (and, for a new row, its label in every locale).
- The api reads only `scope` and `label`; its `PermissionRegistry` type picks those two fields.
- The Roles page still lists keys by area (`permissionGroups`); it can move to the grid later.
