import { z } from 'zod';
import { TABLE_MAX_SEATS, TABLE_NAME_MAX_LENGTH, TABLE_SHAPES } from '../api/pos-tables';

/**
 * A floor plan's layout (docs/modules/pos.md → Step 8, ADR 0073): a room and what stands in it. Units are the same both
 * ways; the room's longer side is 1000. Positions are the top left corner. Pure: the designer and the api share it.
 */

export const FLOOR_PLAN_UNITS = 1000;
/** The room's shorter side: at most 1 : 5. */
export const FLOOR_PLAN_MIN_SIDE = 200;
export const FLOOR_PLAN_SNAP = 10;
export const FLOOR_PLAN_MAX_TABLES = 100;
export const FLOOR_PLAN_MAX_PIECES = 100;
/** Small enough for a crowded room, big enough to tap. */
export const FLOOR_PLAN_MIN_TABLE = 40;
export const FLOOR_PLAN_MIN_PIECE = 10;

export const FLOOR_PLAN_PIECES = ['wall', 'door', 'bar', 'decor'] as const;
export type FloorPlanPieceKind = (typeof FLOOR_PLAN_PIECES)[number];

const coordinate = z.int().min(0).max(FLOOR_PLAN_UNITS);
const side = (min: number) => z.int().min(min).max(FLOOR_PLAN_UNITS);

/** Identifies an item inside one layout (new tables have no id yet). */
const key = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const floorPlanRoomSchema = z
  .strictObject({ width: side(FLOOR_PLAN_MIN_SIDE), height: side(FLOOR_PLAN_MIN_SIDE) })
  .refine((room) => Math.max(room.width, room.height) === FLOOR_PLAN_UNITS);

export const newFloorTableSchema = z.strictObject({
  name: z.string().trim().min(1).max(TABLE_NAME_MAX_LENGTH),
  seats: z.int().min(1).max(TABLE_MAX_SEATS),
  shape: z.enum(TABLE_SHAPES),
});

const box = (min: number) => ({
  key,
  x: coordinate,
  y: coordinate,
  width: side(min),
  height: side(min),
});

export const floorPlanTableSchema = z
  .strictObject({
    ...box(FLOOR_PLAN_MIN_TABLE),
    tableId: z.uuid().nullable(),
    /** A table that doesn't exist yet: created when the plan is published. */
    create: newFloorTableSchema.nullable(),
  })
  .refine((table) => (table.tableId === null) !== (table.create === null));

export const floorPlanPieceSchema = z.strictObject({
  ...box(FLOOR_PLAN_MIN_PIECE),
  kind: z.enum(FLOOR_PLAN_PIECES),
});

const unique = (values: readonly string[]) => new Set(values).size === values.length;

export const floorPlanLayoutSchema = z
  .strictObject({
    room: floorPlanRoomSchema,
    tables: z.array(floorPlanTableSchema).max(FLOOR_PLAN_MAX_TABLES),
    pieces: z.array(floorPlanPieceSchema).max(FLOOR_PLAN_MAX_PIECES),
  })
  .superRefine((layout, ctx) => {
    const items = [...layout.tables, ...layout.pieces];
    if (items.some((i) => !insideRoom(i, layout.room))) {
      ctx.addIssue({ code: 'custom', message: 'An item is outside the room' });
    }
    if (!unique(items.map((i) => i.key))) {
      ctx.addIssue({ code: 'custom', message: 'A key is used twice' });
    }
    if (!unique(layout.tables.flatMap((t) => (t.tableId ? [t.tableId] : [])))) {
      ctx.addIssue({ code: 'custom', message: 'A table is on the plan twice' });
    }
    if (!unique(layout.tables.flatMap((t) => (t.create ? [t.create.name] : [])))) {
      ctx.addIssue({ code: 'custom', message: 'A new table name is used twice' });
    }
  });

export type FloorPlanRoom = z.infer<typeof floorPlanRoomSchema>;
export type FloorPlanTable = z.infer<typeof floorPlanTableSchema>;
export type FloorPlanPiece = z.infer<typeof floorPlanPieceSchema>;
export type FloorPlanLayout = z.infer<typeof floorPlanLayoutSchema>;
export type NewFloorTable = z.infer<typeof newFloorTableSchema>;

export interface FloorPlanBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function insideRoom(box: FloorPlanBox, room: FloorPlanRoom): boolean {
  return (
    box.x >= 0 && box.y >= 0 && box.x + box.width <= room.width && box.y + box.height <= room.height
  );
}

export function snap(value: number, step = FLOOR_PLAN_SNAP): number {
  // `+ 0`: never -0.
  return Math.round(value / step) * step + 0;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The box at its size, moved into the room (a box larger than the room is cut to it first). */
export function intoRoom<T extends FloorPlanBox>(box: T, room: FloorPlanRoom, min: number): T {
  const width = clamp(box.width, min, room.width);
  const height = clamp(box.height, min, room.height);
  return {
    ...box,
    width,
    height,
    x: clamp(box.x, 0, room.width - width),
    y: clamp(box.y, 0, room.height - height),
  };
}

/** Touching edges don't overlap. */
export function overlap(a: FloorPlanBox, b: FloorPlanBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Keys of the tables that overlap another table or a wall, door or bar; decor may lie under a table (a carpet). */
export function overlappingTables(layout: FloorPlanLayout): Set<string> {
  const solid = layout.pieces.filter((p) => p.kind !== 'decor');
  const found = new Set<string>();
  layout.tables.forEach((table, i) => {
    if (solid.some((piece) => overlap(table, piece))) found.add(table.key);
    for (const other of layout.tables.slice(i + 1)) {
      if (!overlap(table, other)) continue;
      found.add(table.key);
      found.add(other.key);
    }
  });
  return found;
}

/** A room in metres as units: its longer side becomes 1000. Null when the sides differ too much. */
export function roomFromMetres(width: number, height: number): FloorPlanRoom | null {
  const scale = FLOOR_PLAN_UNITS / Math.max(width, height);
  const room = { width: Math.round(width * scale), height: Math.round(height * scale) };
  return floorPlanRoomSchema.safeParse(room).success ? room : null;
}
