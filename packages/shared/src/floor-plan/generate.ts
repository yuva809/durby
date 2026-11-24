import { TABLE_MAX_SEATS, TABLE_NAME_MAX_LENGTH, type TableShape } from '../api/pos-tables';
import {
  FLOOR_PLAN_MAX_TABLES,
  FLOOR_PLAN_MIN_TABLE,
  type FloorPlanLayout,
  type FloorPlanRoom,
  type FloorPlanTable,
  roomFromMetres,
} from './layout';

/** The floor plan generator (ADR 0073): a pure function from a room and a table count to a draft layout. */

export const GENERATOR_MIN_METRES = 2;
export const GENERATOR_MAX_METRES = 60;

/** Metres around every table: chairs on both sides of the gap and room to walk between them. */
const GAP = 1.2;
/** Metres to the walls: a chair. */
const EDGE = 0.6;

export interface ExistingFloorTable {
  id: string;
  name: string;
  seats: number;
  shape: TableShape;
}

export interface GeneratorInput {
  /** Metres. */
  width: number;
  height: number;
  /** Tables in all, existing ones included. */
  tables: number;
  /** Seats and shape of the new tables; existing ones keep theirs. */
  seats: number;
  shape: TableShape;
  /** The area's tables in service, in their order: always placed, first. */
  existing: readonly ExistingFloorTable[];
  /** Names that are taken elsewhere at the location: new tables don't use them. */
  takenNames: readonly string[];
}

export type GeneratorResult =
  | { ok: true; layout: FloorPlanLayout }
  | { ok: false; reason: 'room' }
  /** More tables exist than asked for: the generator never leaves one out. */
  | { ok: false; reason: 'existing'; existing: number }
  | { ok: false; reason: 'too_many'; fits: number };

interface Size {
  width: number;
  height: number;
}

/** A table's size in metres, by seats: about 60 cm of edge per guest. */
export function tableMetres(seats: number, shape: TableShape): Size {
  const guests = Math.max(1, seats);
  if (shape === 'round') {
    const diameter = Math.max(0.7, (guests * 0.6) / Math.PI);
    return { width: diameter, height: diameter };
  }
  if (shape === 'square' && guests <= 4) {
    const edge = guests <= 2 ? 0.7 : 0.9;
    return { width: edge, height: edge };
  }
  // Guests on both long sides, as many as needed; the ends stay free.
  return { width: Math.max(1.2, Math.ceil(guests / 2) * 0.6), height: 0.8 };
}

interface Placed extends Size {
  x: number;
  y: number;
}

/** Rows from the top left; null when not all fit. Everything in metres. */
function rows(sizes: readonly Size[], room: Size): Placed[] | null {
  const placed: Placed[] = [];
  let x = EDGE;
  let y = EDGE;
  let rowHeight = 0;
  for (const size of sizes) {
    if (x > EDGE && x + size.width > room.width - EDGE + 1e-9) {
      x = EDGE;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    if (x + size.width > room.width - EDGE + 1e-9 || y + size.height > room.height - EDGE + 1e-9) {
      return null;
    }
    placed.push({ ...size, x, y });
    x += size.width + GAP;
    rowHeight = Math.max(rowHeight, size.height);
  }
  return placed;
}

/** The prefix most of the names share before their number ("T" of T1, T2, Bar 1); null when none has one. */
function commonPrefix(names: readonly string[]): string | null {
  const prefixes = new Map<string, number>();
  for (const name of names) {
    const match = /^(.*?)(\d{1,4})$/.exec(name);
    if (match) prefixes.set(match[1]!, (prefixes.get(match[1]!) ?? 0) + 1);
  }
  return [...prefixes].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))[0]?.[0] ?? null;
}

/** The area's own naming goes on ("Terrace 2"), else the location's, else T1, T2, …; taken names are skipped. */
function nextNames(count: number, own: readonly string[], elsewhere: readonly string[]): string[] {
  const taken = new Set([...own, ...elsewhere]);
  const prefix = commonPrefix(own) ?? commonPrefix(elsewhere) ?? 'T';
  const result: string[] = [];
  for (let n = 1; result.length < count; n += 1) {
    const name = `${prefix.slice(0, TABLE_NAME_MAX_LENGTH - 6)}${n}`;
    if (taken.has(name)) continue;
    taken.add(name);
    result.push(name);
  }
  return result;
}

const clampSeats = (seats: number) => Math.min(Math.max(Math.round(seats), 1), TABLE_MAX_SEATS);

export function generateFloorPlan(input: GeneratorInput): GeneratorResult {
  const inRange = (metres: number) =>
    metres >= GENERATOR_MIN_METRES && metres <= GENERATOR_MAX_METRES;
  const room = roomFromMetres(input.width, input.height);
  if (!room || !inRange(input.width) || !inRange(input.height)) {
    return { ok: false, reason: 'room' };
  }
  const { existing } = input;
  if (input.tables < existing.length) {
    return { ok: false, reason: 'existing', existing: existing.length };
  }
  const scale = Math.max(room.width, room.height) / Math.max(input.width, input.height);
  // In a large room a table would be too small to tap: it takes that much room in the draft.
  const least = FLOOR_PLAN_MIN_TABLE / scale;
  const sizeOf = (seats: number, shape: TableShape): Size => {
    const size = tableMetres(seats, shape);
    return { width: Math.max(size.width, least), height: Math.max(size.height, least) };
  };
  const seats = clampSeats(input.seats);
  const metres = { width: input.width, height: input.height };
  const sizes = (count: number): Size[] => [
    ...existing.map((t) => sizeOf(t.seats, t.shape)),
    ...Array.from({ length: Math.max(0, count - existing.length) }, () =>
      sizeOf(seats, input.shape),
    ),
  ];
  const wanted = Math.min(input.tables, FLOOR_PLAN_MAX_TABLES);
  const placed = input.tables <= FLOOR_PLAN_MAX_TABLES ? rows(sizes(wanted), metres) : null;
  if (!placed) {
    let fits = 0;
    for (let count = wanted; count >= existing.length; count -= 1) {
      if (!rows(sizes(count), metres)) continue;
      fits = count;
      break;
    }
    return { ok: false, reason: 'too_many', fits };
  }
  const names = nextNames(
    placed.length - existing.length,
    existing.map((t) => t.name),
    input.takenNames,
  );
  return {
    ok: true,
    layout: {
      room,
      pieces: [],
      tables: placed.map((at, i): FloorPlanTable => {
        const table = existing[i];
        return {
          key: `t-${i + 1}`,
          ...units(at, scale, room),
          tableId: table?.id ?? null,
          create: table ? null : { name: names[i - existing.length]!, seats, shape: input.shape },
        };
      }),
    },
  };
}

/** Metres to whole units, rounded so that neighbours can't grow into each other. */
function units(at: Placed, scale: number, room: FloorPlanRoom) {
  const width = Math.max(FLOOR_PLAN_MIN_TABLE, Math.floor(at.width * scale));
  const height = Math.max(FLOOR_PLAN_MIN_TABLE, Math.floor(at.height * scale));
  return {
    x: Math.min(Math.round(at.x * scale), room.width - width),
    y: Math.min(Math.round(at.y * scale), room.height - height),
    width,
    height,
  };
}
