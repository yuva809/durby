import { type FloorPlanLayout, floorPlanLayoutSchema, overlappingTables } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  type EditorAction,
  editorReducer,
  type EditorState,
  initialEditor,
  sameLayout,
  withoutGone,
} from './plan-editor';

const id = (n: number) => `0190a000-0000-7000-8000-000000000${String(n).padStart(3, '0')}`;
const LAYOUT: FloorPlanLayout = {
  room: { width: 1000, height: 600 },
  tables: [
    { key: 't-1', x: 100, y: 100, width: 80, height: 80, tableId: id(1), create: null },
    {
      key: 't-2',
      x: 300,
      y: 100,
      width: 80,
      height: 80,
      tableId: null,
      create: { name: 'T2', seats: 4, shape: 'square' },
    },
  ],
  pieces: [{ key: 'wall-1', kind: 'wall', x: 0, y: 0, width: 300, height: 20 }],
};

const run = (state: EditorState, ...actions: EditorAction[]) =>
  actions.reduce((s, action) => {
    const next = editorReducer(s, action);
    // Whatever happens, the layout can be saved.
    expect(floorPlanLayoutSchema.safeParse(next.layout).success, JSON.stringify(action)).toBe(true);
    return next;
  }, state);
const start = () => initialEditor(LAYOUT);
const box = (state: EditorState, key: string) => {
  const item = [...state.layout.tables, ...state.layout.pieces].find((i) => i.key === key)!;
  return [item.x, item.y, item.width, item.height];
};
const place = (key: string, b: object, exact = false): EditorAction => ({
  type: 'place',
  key,
  box: b,
  exact,
});

describe('floor plan editor', () => {
  it('snaps and keeps items in the room', () => {
    const state = run(start(), place('t-1', { x: 127, y: 583 }));
    expect(box(state, 't-1')).toEqual([130, 520, 80, 80]);
    expect(box(run(state, place('t-1', { x: -50 })), 't-1')).toEqual([0, 520, 80, 80]);
    expect(box(run(state, place('t-1', { width: 5, height: 3000 })), 't-1')).toEqual([
      130, 0, 40, 600,
    ]);
    // Exact values from the fields; nonsense is ignored.
    expect(box(run(state, place('t-1', { x: 127.4 }, true)), 't-1')[0]).toBe(127);
    expect(run(state, place('t-1', { x: Number.NaN }))).toBe(state);
    expect(box(run(state, place('wall-1', { height: 1 })), 'wall-1')).toEqual([0, 0, 300, 10]);
  });

  it('a drag is one step, whatever it passes through', () => {
    const state = run(
      start(),
      { type: 'dragStart', key: 't-1' },
      place('t-1', { x: 150 }),
      place('t-1', { x: 200 }),
      place('t-1', { x: 250 }),
    );
    expect(state.selected).toBe('t-1');
    expect(state.past).toHaveLength(0);
    // No undo in the middle of a drag.
    expect(run(state, { type: 'undo' })).toBe(state);
    const ended = run(state, { type: 'dragEnd' });
    expect(ended.past).toEqual([LAYOUT]);
    expect(box(ended, 't-1')[0]).toBe(250);
    expect(run(ended, { type: 'undo' }).layout).toBe(LAYOUT);
    expect(run(state, { type: 'dragCancel' }).layout).toBe(LAYOUT);
    // A tap that moves nothing is no step.
    expect(run(start(), { type: 'dragStart', key: 't-1' }, { type: 'dragEnd' }).past).toEqual([]);
  });

  it('undoes and redoes; a new change drops what was undone', () => {
    let state = run(start(), place('t-1', { x: 200 }), place('t-1', { x: 400 }));
    state = run(state, { type: 'undo' });
    expect(box(state, 't-1')[0]).toBe(200);
    state = run(state, { type: 'redo' });
    expect(box(state, 't-1')[0]).toBe(400);
    state = run(state, { type: 'undo' }, { type: 'undo' });
    expect(state.layout).toBe(LAYOUT);
    expect(run(state, { type: 'undo' })).toBe(state);
    state = run(state, place('t-2', { x: 500 }));
    expect(state.future).toEqual([]);
    expect(run(state, { type: 'redo' })).toBe(state);
    // Setting what is there already is no step.
    expect(run(state, place('t-2', { x: 500 }))).toBe(state);
  });

  it('adds pieces and tables where there is room, once', () => {
    let state = run(start(), { type: 'addPiece', kind: 'bar' }, { type: 'addPiece', kind: 'bar' });
    expect(state.layout.pieces.map((p) => p.key)).toEqual(['wall-1', 'bar-1', 'bar-2']);
    expect(state.selected).toBe('bar-2');
    state = run(
      state,
      { type: 'addTable', tableId: id(3), seats: 4 },
      { type: 'addTable', tableId: id(3), seats: 4 },
    );
    expect(state.layout.tables.map((t) => t.key)).toEqual(['t-1', 't-2', 't-3']);
    expect([...overlappingTables(state.layout)]).toEqual([]);
    expect(run(start(), { type: 'addTable', tableId: id(1), seats: 4 }).layout).toBe(LAYOUT);
  });

  it('a wide piece fits a narrow room', () => {
    const narrow = initialEditor({ room: { width: 200, height: 1000 }, tables: [], pieces: [] });
    expect(box(run(narrow, { type: 'addPiece', kind: 'bar' }), 'bar-1')[2]).toBe(200);
  });

  it('a room full of things still takes one more', () => {
    let state = initialEditor({
      room: { width: 1000, height: 200 },
      tables: [],
      pieces: [{ key: 'wall-1', kind: 'wall', x: 0, y: 0, width: 1000, height: 200 }],
    });
    state = run(state, { type: 'addTable', tableId: id(1), seats: 8 });
    expect(box(state, 't-1')).toEqual([0, 0, 110, 80]);
  });

  it('changes new tables only, and removes anything', () => {
    let state = run(
      start(),
      { type: 'rename', key: 't-2', create: { name: 'Window' } },
      { type: 'rename', key: 't-1', create: { name: 'No' } },
    );
    expect(state.layout.tables.map((t) => t.create?.name)).toEqual([undefined, 'Window']);
    state = run(state, { type: 'select', key: 't-1' }, { type: 'remove', key: 't-1' });
    expect(state.layout.tables.map((t) => t.key)).toEqual(['t-2']);
    expect(state.selected).toBeNull();
    expect(run(state, { type: 'remove', key: 'wall-1' }).layout.pieces).toEqual([]);
  });

  it('a smaller room pulls everything inside', () => {
    const state = run(start(), place('t-1', { x: 900, y: 500 }), {
      type: 'room',
      room: { width: 300, height: 1000 },
    });
    expect(box(state, 't-1')).toEqual([220, 500, 80, 80]);
    expect(box(state, 'wall-1')).toEqual([0, 0, 300, 20]);
  });

  it('a generated layout is one step back', () => {
    const generated = { ...LAYOUT, tables: [] };
    const state = run(start(), { type: 'replace', layout: generated });
    expect(state.layout).toBe(generated);
    expect(run(state, { type: 'undo' }).layout).toBe(LAYOUT);
  });

  it('loading starts over', () => {
    const state = run(start(), place('t-1', { x: 200 }), { type: 'load', layout: LAYOUT });
    expect(state).toEqual(initialEditor(LAYOUT));
  });

  it('leaves out tables that are gone, keeps new ones', () => {
    expect(withoutGone(LAYOUT, new Set([id(1)]))).toBe(LAYOUT);
    expect(withoutGone(LAYOUT, new Set()).tables.map((t) => t.key)).toEqual(['t-2']);
    expect(sameLayout(LAYOUT, structuredClone(LAYOUT))).toBe(true);
    expect(sameLayout(LAYOUT, withoutGone(LAYOUT, new Set()))).toBe(false);
  });
});
