import { describe, expect, it } from 'vitest';
import { TABLE_SHAPES } from '../api/pos-tables';
import { generateFloorPlan, type GeneratorInput } from './generate';
import {
  FLOOR_PLAN_MAX_TABLES,
  floorPlanLayoutSchema,
  intoRoom,
  overlap,
  overlappingTables,
  roomFromMetres,
  snap,
} from './layout';

const id = (n: number) => `0190a000-0000-7000-8000-000000000${String(n).padStart(3, '0')}`;
const room = { width: 1000, height: 600 };
const table = (key: string, extra: object = {}) => ({
  key,
  x: 100,
  y: 100,
  width: 80,
  height: 80,
  tableId: id(1),
  create: null,
  ...extra,
});
const fresh = (name: string) => ({
  tableId: null,
  create: { name, seats: 4, shape: 'square' as const },
});
const piece = (key: string, extra: object = {}) => ({
  key,
  kind: 'wall',
  x: 0,
  y: 0,
  width: 200,
  height: 10,
  ...extra,
});
const ok = (layout: object) => floorPlanLayoutSchema.safeParse(layout).success;

describe('floor plan layout (ADR 0073)', () => {
  it('takes tables and pieces inside the room', () => {
    expect(ok({ room, tables: [], pieces: [] })).toBe(true);
    expect(
      ok({
        room,
        tables: [table('a'), table('b', { x: 920, y: 520, ...fresh('T2') })],
        pieces: [piece('w'), piece('d', { kind: 'decor', x: 800 })],
      }),
    ).toBe(true);
  });

  it('refuses rooms that are not 1000 on their longer side, or too narrow', () => {
    for (const bad of [
      { width: 900, height: 600 },
      { width: 1001, height: 600 },
      { width: 1000, height: 199 },
      { width: 1000 },
    ]) {
      expect(ok({ room: bad, tables: [], pieces: [] })).toBe(false);
    }
    expect(ok({ room: { width: 400, height: 1000 }, tables: [], pieces: [] })).toBe(true);
  });

  it('refuses what is outside, too small, not whole or unknown', () => {
    for (const extra of [
      { x: 921 },
      { y: 521 },
      { x: -1 },
      { width: 39 },
      { x: 10.5 },
      { width: 1001 },
      { rotation: 90 },
      { tableId: 'T1' },
      { tableId: null },
      { create: { name: 'T9', seats: 4, shape: 'square' } },
      { tableId: null, create: { name: ' ', seats: 4, shape: 'square' } },
      { tableId: null, create: { name: 'T9', seats: 0, shape: 'square' } },
      { tableId: null, create: { name: 'T9', seats: 4, shape: 'star' } },
      { key: 'A B' },
    ]) {
      expect(ok({ room, tables: [table('a', extra)], pieces: [] }), JSON.stringify(extra)).toBe(
        false,
      );
    }
    expect(ok({ room, tables: [], pieces: [piece('w', { kind: 'lamp' })] })).toBe(false);
    expect(ok({ room, tables: [], pieces: [piece('w', { height: 9 })] })).toBe(false);
  });

  it('refuses anything twice, and too many', () => {
    const two = (b: object) =>
      ok({ room, tables: [table('a'), table('b', { tableId: id(2), ...b })], pieces: [] });
    expect(two({})).toBe(true);
    expect(two({ key: 'a' })).toBe(false);
    expect(two({ tableId: id(1) })).toBe(false);
    expect(
      ok({ room, tables: [table('a', fresh('T1')), table('b', fresh(' T1 '))], pieces: [] }),
    ).toBe(false);
    const many = (n: number) =>
      ok({
        room,
        tables: Array.from({ length: n }, (_, i) => table(`t-${i}`, fresh(`T${i}`))),
        pieces: [],
      });
    expect(many(FLOOR_PLAN_MAX_TABLES)).toBe(true);
    expect(many(FLOOR_PLAN_MAX_TABLES + 1)).toBe(false);
    expect(
      ok({ room, tables: [], pieces: Array.from({ length: 101 }, (_, i) => piece(`p-${i}`)) }),
    ).toBe(false);
  });

  it('snaps, keeps boxes in the room and finds overlaps', () => {
    expect([0, 4, 5, 14, 996].map((v) => snap(v))).toEqual([0, 0, 10, 10, 1000]);
    expect(Object.is(snap(-3), 0)).toBe(true);
    const box = { x: 990, y: -20, width: 80, height: 80 };
    expect(intoRoom(box, room, 40)).toEqual({ x: 920, y: 0, width: 80, height: 80 });
    expect(intoRoom({ ...box, width: 5000, height: 1 }, room, 40)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 40,
    });
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(overlap(a, { ...a, x: 10 })).toBe(false);
    expect(overlap(a, { ...a, x: 9 })).toBe(true);
  });

  it('marks tables on tables, walls, doors and bars, but not on decor', () => {
    const layout = floorPlanLayoutSchema.parse({
      room,
      tables: [
        table('a'),
        table('b', { x: 150, tableId: id(2) }),
        table('c', { x: 400, tableId: id(3) }),
        table('d', { x: 600, tableId: id(4) }),
        table('e', { x: 800, tableId: id(5) }),
      ],
      pieces: [
        piece('w', { x: 390, y: 120 }),
        piece('p', { kind: 'decor', x: 790, y: 90, height: 100 }),
      ].map((p) => (p.key === 'w' ? { ...p, width: 100 } : p)),
    });
    expect([...overlappingTables(layout)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('turns metres into a room', () => {
    expect(roomFromMetres(10, 6)).toEqual({ width: 1000, height: 600 });
    expect(roomFromMetres(6, 12)).toEqual({ width: 500, height: 1000 });
    expect(roomFromMetres(20, 2)).toBeNull();
  });
});

describe('floor plan generator (ADR 0073)', () => {
  const input = (extra: Partial<GeneratorInput> = {}): GeneratorInput => ({
    width: 10,
    height: 8,
    tables: 12,
    seats: 4,
    shape: 'square',
    existing: [],
    takenNames: [],
    ...extra,
  });
  const existing = (n: number, seats = 4) =>
    Array.from({ length: n }, (_, i) => ({
      id: id(i + 1),
      name: `T${i + 1}`,
      seats,
      shape: 'square' as const,
    }));
  const draft = (extra: Partial<GeneratorInput> = {}) => {
    const result = generateFloorPlan(input(extra));
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.layout;
  };

  it('fills rows with new tables', () => {
    const layout = draft();
    expect(layout.room).toEqual({ width: 1000, height: 800 });
    expect(layout.tables).toHaveLength(12);
    expect(layout.tables.map((t) => t.create?.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `T${i + 1}`),
    );
    // As many in each row as in the others: 4 + 4 + 4, spread over the room.
    const perRow = new Map<number, number>();
    for (const t of layout.tables) perRow.set(t.y, (perRow.get(t.y) ?? 0) + 1);
    expect([...perRow.values()]).toEqual([4, 4, 4]);
    expect(layout.tables[0]).toMatchObject({ width: 90, height: 90 });
    // 10 m - 4 x 0.9 m - 3 x 1.2 m - 2 x 0.6 m leaves 1.6 m for five gaps.
    expect(layout.tables.slice(0, 4).map((t) => t.x)).toEqual([92, 334, 576, 818]);
    const right = layout.tables[3]!;
    expect(1000 - right.x - right.width).toBe(layout.tables[0]!.x);
  });

  it('places the existing tables first and creates only the rest', () => {
    const layout = draft({ tables: 7, existing: existing(5) });
    expect(layout.tables.map((t) => t.tableId)).toEqual([
      ...existing(5).map((t) => t.id),
      null,
      null,
    ]);
    expect(layout.tables.slice(5).map((t) => t.create)).toEqual([
      { name: 'T6', seats: 4, shape: 'square' },
      { name: 'T7', seats: 4, shape: 'square' },
    ]);
    expect(draft({ tables: 5, existing: existing(5) }).tables.every((t) => t.tableId)).toBe(true);
  });

  it('never leaves an existing table out', () => {
    expect(generateFloorPlan(input({ tables: 3, existing: existing(5) }))).toEqual({
      ok: false,
      reason: 'existing',
      existing: 5,
    });
  });

  it('numbers on with the names in use and skips taken ones', () => {
    const names = (extra: Partial<GeneratorInput>) =>
      draft(extra).tables.flatMap((t) => (t.create ? [t.create.name] : []));
    expect(names({ tables: 3, takenNames: ['T1', 'T3'] })).toEqual(['T2', 'T4', 'T5']);
    const terrace = [{ id: id(1), name: 'Terrace 1', seats: 4, shape: 'round' as const }];
    expect(names({ tables: 3, existing: terrace, takenNames: ['T1'] })).toEqual([
      'Terrace 2',
      'Terrace 3',
    ]);
    expect(names({ tables: 2, takenNames: ['Window'] })).toEqual(['T1', 'T2']);
  });

  it('says how many fit, and makes no draft', () => {
    const result = generateFloorPlan(input({ width: 4.2, height: 4.2, tables: 30 }));
    expect(result).toEqual({ ok: false, reason: 'too_many', fits: 4 });
    expect(generateFloorPlan(input({ width: 4.2, height: 4.2, tables: 4 })).ok).toBe(true);
    expect(generateFloorPlan(input({ width: 4.2, height: 4.2, tables: 5 })).ok).toBe(false);
    // Already too many existing ones: none of them fit together.
    expect(
      generateFloorPlan(input({ width: 3, height: 3, tables: 9, existing: existing(9) })),
    ).toEqual({ ok: false, reason: 'too_many', fits: 0 });
    expect(
      generateFloorPlan(input({ width: 60, height: 60, tables: 101, seats: 2 })),
    ).toMatchObject({ ok: false, reason: 'too_many', fits: 100 });
  });

  it('refuses rooms out of range', () => {
    for (const [width, height] of [
      [1, 5],
      [61, 30],
      [50, 5],
      [Number.NaN, 5],
      [0, 0],
    ] as const) {
      expect(generateFloorPlan(input({ width, height }))).toEqual({ ok: false, reason: 'room' });
    }
  });

  it('always makes a valid layout without overlaps, the same one each time', () => {
    let made = 0;
    for (const [width, height] of [
      [4, 4],
      [10, 8],
      [7.3, 12.9],
      [25, 9],
      [60, 60],
      [60, 13],
    ] as const) {
      for (const shape of TABLE_SHAPES) {
        for (const seats of [1, 2, 4, 6, 10, 100]) {
          for (const tables of [1, 5, 17, 60, 100]) {
            const ask = input({ width, height, shape, seats, tables, existing: existing(1, 6) });
            const result = generateFloorPlan(ask);
            expect(generateFloorPlan(ask)).toEqual(result);
            if (!result.ok) {
              expect(result.reason).toBe('too_many');
              continue;
            }
            made += 1;
            const parsed = floorPlanLayoutSchema.safeParse(result.layout);
            expect(parsed.success, JSON.stringify(ask)).toBe(true);
            expect([...overlappingTables(result.layout)], JSON.stringify(ask)).toEqual([]);
            expect(result.layout.tables).toHaveLength(tables);
          }
        }
      }
    }
    expect(made).toBeGreaterThan(100);
  });

  it('what it says fits does fit', () => {
    for (const seats of [2, 4, 8]) {
      const result = generateFloorPlan(input({ width: 9, height: 7, tables: 100, seats }));
      if (result.ok || result.reason !== 'too_many') throw new Error('expected too many');
      expect(generateFloorPlan(input({ width: 9, height: 7, tables: result.fits, seats })).ok).toBe(
        true,
      );
      expect(
        generateFloorPlan(input({ width: 9, height: 7, tables: result.fits + 1, seats })).ok,
      ).toBe(false);
    }
  });
});
