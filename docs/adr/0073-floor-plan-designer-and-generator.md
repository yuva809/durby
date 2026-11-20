# ADR 0073: Floor plan designer and generator

- Status: accepted
- Date: 2026-11-20
- Step: table management, floor plan (builds on the tables page and the floor positions of ADR 0016 and ADR 0069).
  Uses the permissions `pos.tables.read` and `pos.tables.edit` (ADR 0007).

## Context

The tables page places each table by dragging it on a plan, and a table has a shape, a colour and an area. A new
room means placing every table by hand, and the plan can't hold anything besides tables. Managers asked for a
generator that makes a starting plan from a table count and room size, and a designer to fine-tune it.

## Decisions

1. **A plan per area.** Each dining area (ADR 0016 areas) has its own plan. Tables outside an area keep the plan of the
   location.
2. **Plans are versioned and append-only.** `pos_floor_plan_versions` holds one row per save: area, sequence number,
   the layout as JSON, who saved it and when. Nothing is edited or deleted. Restoring an old version writes a new
   version that copies it (CLAUDE rule 7).
3. **The layout is validated.** A layout is a list of items: a table reference, or a wall, bar or decor piece with a
   position and a size. Every number is an integer on a 0–1000 grid; sizes and counts have strict limits; an unknown
   table id is refused.
4. **Publishing copies the table positions** onto `dining_tables` (`floor_x`, `floor_y`, and a new nullable
   `floor_w`, `floor_h` for table size). The floor and order screens keep reading the same columns, so nothing else
   changes. Walls, bars and decor are stored in the plan only.
5. **The generator is a pure function.** From a table count, the seats per table and a room size it produces a layout
   in rows, spaced for the seats. It saves nothing: the output is a draft the user edits and saves as a version.
6. **Designer behaviour**: drag, resize (tables and non-table pieces), snap to a 10-unit grid, delete, and add
   wall/bar/decor pieces. Undo is the previous version (save history), not an in-memory stack.
7. **No rotation in version one.** Rectangular tables keep the long-table shape, and rotation is a later decision.
8. **Permissions**: viewing a plan needs `pos.tables.read`; saving, restoring and publishing need `pos.tables.edit`.
9. **Audit**: `pos.floor_plan.saved`, `pos.floor_plan.restored`, `pos.floor_plan.published`, with the area and the
   version number (no free text).

## Consequences

- Expand-only migrations: two new tables, two nullable columns on `dining_tables`.
- Phones keep the plain table list, as now (below 1024 px).
- Not in version one: rotation, multi-floor plans, live multi-user editing, 3D.
