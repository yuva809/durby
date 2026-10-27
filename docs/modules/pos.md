# POS module: table service

Restaurant table service: tables per location (step 1), waiter orders and kitchen tickets (step 3), guest checks
and the billing counter (step 4). Code: `apps/api/src/modules/pos/`. Decisions:
[ADR 0016](../adr/0016-table-service-before-tse.md). Fiscal receipts and payments are **not** part of this module
yet: they need a TSE (`pos.fiscal`, a later step).

## Roadmap

| Step | Delivers                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | Dining tables per location (owner / admin / manager manage them). Catalog: [catalog.md](catalog.md).                        |
| 2    | `waiter` and `cashier` system roles (ADR 0007 amendment).                                                                   |
| 3    | Orders: a waiter picks a table, adds products, confirms → order number + kitchen ticket print view.                         |
| 4    | Guest checks ("Zwischenrechnung", not a receipt): print from the table; billing counter lists open, recent and past checks. |

Steps 2–4 get their own plan and update this spec before they are built.

## Step 1: dining tables

```
Organization (tenant)
 └─ Location
     └─ DiningTable   dining_tables   tenant table (RLS)
```

| Table           | Columns                                                                                            | Notes                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dining_tables` | `id`, `tenant_id`, `location_id`, `name`, `seats`, `area`, `sort_order`, `archived_at`, timestamps | `(tenant_id, location_id)` → locations, `RESTRICT`. Name unique per location among non-archived |

- `name`: trimmed 1–50 (e.g. "T1", "Terrace 4"). `seats`: integer 1–100. `area`: optional trimmed 1–50 ("Terrace").
- Archive, never delete: orders and checks (steps 3–4) reference tables.
- Feature: the existing `pos`. Organizations on plans without `pos` get 403 `entitlements.feature_disabled`.

### Permissions

| Key                 | Scope    | Grants                                    | admin | manager | staff |
| ------------------- | -------- | ----------------------------------------- | ----- | ------- | ----- |
| `pos.tables.read`   | location | list a location's tables                  | ✓     | ✓       | ✓     |
| `pos.tables.manage` | location | create, edit, archive a location's tables | ✓     | ✓       |       |

Both are checked **at the table's location**: a location-limited manager manages only their locations' tables.

### API (`/api/v1`, `@RequireFeature('pos')`)

| Method + path           | Permission                                  | Idempotency                 | Body / query                                      |
| ----------------------- | ------------------------------------------- | --------------------------- | ------------------------------------------------- |
| `GET /pos/tables`       | `pos.tables.read` (filters by location)     |                             | `?locationId=&includeArchived=true`               |
| `POST /pos/tables`      | `pos.tables.manage` at `locationId`         | `completion: 'transaction'` | `{ locationId, name, seats, area?, sortOrder? }`  |
| `PATCH /pos/tables/:id` | `pos.tables.manage` at the table's location | response                    | `{ name?, seats?, area?, sortOrder?, archived? }` |

A table can't move to another location (archive it and create a new one). Lists: `sort_order`, name, id.

### Errors

| Code                     | Status | When                                                                             |
| ------------------------ | ------ | -------------------------------------------------------------------------------- |
| `pos.table_not_found`    | 404    | unknown id, another tenant's id, a bad UUID, or a location the caller can't read |
| `pos.location_not_found` | 404    | `locationId` doesn't exist in the organization                                   |
| `pos.table_name_taken`   | 409    | a non-archived table of the location already has this name                       |

Labels: `pos.errors.<camelCase>`.

### Audit

| Action                     | Entity         | Snapshot fields                                                        |
| -------------------------- | -------------- | ---------------------------------------------------------------------- |
| `pos.dining_table.created` | `dining_table` | `id`, `locationId`, `name`, `seats`, `area`, `sortOrder`, `archivedAt` |
| `pos.dining_table.updated` | `dining_table` | same (also archive / unarchive)                                        |

### Web

`/pos/tables` (nav: Modules → Tables, feature `pos`, permission `pos.tables.read`): location picker, list of tables;
create/edit/archive only where the user holds `pos.tables.manage` for the selected location.
