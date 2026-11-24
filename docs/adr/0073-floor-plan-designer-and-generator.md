# ADR 0073: Floor plan designer and generator

- Status: accepted (2026-11-20, amended 2026-11-24 before any code: decisions 2, 3, 4, 6 and 10)
- Date: 2026-11-20
- Step: table management, floor plan (builds on areas and floor positions, [pos](../modules/pos.md) → Areas, and
  [ADR 0069](0069-table-management-placements-moves-merges.md)). Uses `pos.tables.read`, `.create`, `.edit` and
  `pos.orders.read` ([ADR 0007](0007-rbac.md), [ADR 0037](0037-crud-permission-keys.md)).

## Context

The tables page places each table by dragging it on a plan, and a table has a shape, a colour and an area. A new
room means placing every table by hand, and the plan can't hold anything besides tables. Managers asked for a
generator that makes a starting plan from a table count and room size, and a designer to fine-tune it. Waiters see a
plain grid on Service; `dining_tables.floor_x` / `floor_y` are read by the tables page only.

## Decisions

1. **A plan per area.** Each dining area has its own plan. Tables without an area keep today's dragging on the tables
   page.
2. **Plans are versioned and append-only.** `pos_floor_plan_versions` holds one row per save: location, area, version
   number, the layout as JSON, who and when. Restoring an old version writes a new one that copies it (CLAUDE rule 7).
   A version outlives its area: an empty area can be deleted, its history can't, so `area_id` has no foreign key.
3. **The layout is validated.** A room of `width` × `height` units (longer side 1000, the same unit both ways, so a round
   table stays round) and items: a table (an existing one, or a new one with name, seats and shape) or a piece (wall,
   door, bar, decor), each with a position and a size inside the room. Integers, strict limits, no table and no new name
   twice. A table of another area is refused when saving.
4. **Publishing makes a version live**: `pos_floor_plan_publications` (append-only) names the version; the newest one per
   area is live. Every screen reads the live plan. `dining_tables` positions are not touched, so there is one source of
   truth and a rollback shows the old positions. Publishing creates the new tables of the layout (as `POST /pos/tables`
   would, audited), writes a version with their real ids and makes that one live, all in one transaction. It never
   changes, archives or deletes an existing table.
5. **The generator is a pure function.** From a table count, the seats per table, a shape and a room size it produces a
   layout in rows, spaced for the seats. Existing tables of the area are placed first, in their order; the others are
   new. It saves nothing. If the tables don't fit it says how many do, and it never leaves an existing table out.
6. **Designer behaviour**: drag, resize, snap to a 10-unit grid, add and delete pieces, take a table off the plan (it
   stays a table), exact values and keyboard, undo and redo. Saved versions are the history beyond that.
7. **No rotation in version one.** Rectangular tables keep the long-table shape, and rotation is a later decision.
8. **Permissions**: viewing a plan needs `pos.tables.read` (on Service `pos.orders.read`); saving, restoring and publishing
   need `pos.tables.edit`, and publishing new tables also `pos.tables.create`, at the area's location.
9. **Audit**: `pos.floor_plan.saved`, `pos.floor_plan.restored`, `pos.floor_plan.published`, with the area, the version
   number and counts (no free text).
10. **Two people editing**: a save or restore names the version it is based on. If a newer one exists it answers
    `409 pos.floor_plan_changed`. Writes lock the area's row.
11. **Service shows the live plan** from 768 px, with a Plan / List switch kept in the page address. A table that left the
    area or is out of service disappears from the plan; one of the area that is not on it is listed below. Areas without
    a live plan, and phones, show the list.

## Consequences

- Expand-only migration: two new tables. A rollback needs nothing.
- The tables page's "All" tab is a grid once its location has a live plan (several rooms can't share one canvas).
- Not in version one: rotation, multi-floor plans, live multi-user editing, 3D, background images, the host screen.
