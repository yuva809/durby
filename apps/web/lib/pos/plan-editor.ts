import {
  FLOOR_PLAN_MAX_PIECES,
  FLOOR_PLAN_MAX_TABLES,
  FLOOR_PLAN_MIN_PIECE,
  FLOOR_PLAN_MIN_TABLE,
  type FloorPlanBox,
  type FloorPlanLayout,
  type FloorPlanPieceKind,
  type FloorPlanRoom,
  intoRoom,
  type NewFloorTable,
  overlap,
  snap,
} from '@durby/shared';

/** The floor plan designer's state (ADR 0073): one pure reducer, so every step can be undone and tested. */

export interface EditorState {
  layout: FloorPlanLayout;
  past: readonly FloorPlanLayout[];
  future: readonly FloorPlanLayout[];
  selected: string | null;
  /** The layout when a drag started: the whole drag is one step. */
  before: FloorPlanLayout | null;
}

export type EditorAction =
  | { type: 'load'; layout: FloorPlanLayout }
  | { type: 'select'; key: string | null }
  | { type: 'dragStart'; key: string }
  | { type: 'dragEnd' }
  /** Gives up a drag: back to where it started. */
  | { type: 'dragCancel' }
  /** A new place or size, snapped and kept in the room. */
  | { type: 'place'; key: string; box: Partial<FloorPlanBox>; exact?: boolean }
  | { type: 'addPiece'; kind: FloorPlanPieceKind }
  | { type: 'addTable'; tableId: string; seats: number }
  | { type: 'rename'; key: string; create: Partial<NewFloorTable> }
  | { type: 'remove'; key: string }
  | { type: 'room'; room: FloorPlanRoom }
  /** A whole new layout as one step (the generator). */
  | { type: 'replace'; layout: FloorPlanLayout }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY = 100;

export const EMPTY_LAYOUT: FloorPlanLayout = {
  room: { width: 1000, height: 600 },
  tables: [],
  pieces: [],
};

export const initialEditor = (layout: FloorPlanLayout = EMPTY_LAYOUT): EditorState => ({
  layout,
  past: [],
  future: [],
  selected: null,
  before: null,
});

export const PIECE_SIZES: Record<FloorPlanPieceKind, { width: number; height: number }> = {
  wall: { width: 300, height: 20 },
  door: { width: 90, height: 20 },
  bar: { width: 300, height: 70 },
  decor: { width: 60, height: 60 },
};

type Item = FloorPlanBox & { key: string };

function freeKey(layout: FloorPlanLayout, prefix: string): string {
  const used = new Set([...layout.tables, ...layout.pieces].map((i) => i.key));
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** The first free place from the top left, else the corner. */
function freePlace(layout: FloorPlanLayout, { width, height }: { width: number; height: number }) {
  const { room } = layout;
  const others: FloorPlanBox[] = [...layout.tables, ...layout.pieces];
  for (let y = 30; y + height <= room.height; y += 30) {
    for (let x = 30; x + width <= room.width; x += 30) {
      if (!others.some((o) => overlap({ x, y, width, height }, o))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function change(state: EditorState, layout: FloorPlanLayout): EditorState {
  if (layout === state.layout) return state;
  // While dragging only the picture changes; the step is recorded at the end.
  if (state.before) return { ...state, layout };
  return {
    ...state,
    layout,
    past: [...state.past.slice(-HISTORY + 1), state.layout],
    future: [],
  };
}

const same = (a: FloorPlanBox, b: FloorPlanBox) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function updateItem(
  layout: FloorPlanLayout,
  key: string,
  update: <T extends Item>(item: T, min: number) => T,
): FloorPlanLayout {
  let changed = false;
  const each = <T extends Item>(items: T[], min: number): T[] =>
    items.map((item) => {
      if (item.key !== key) return item;
      const next = update(item, min);
      if (same(next, item)) return item;
      changed = true;
      return next;
    });
  const tables = each(layout.tables, FLOOR_PLAN_MIN_TABLE);
  const pieces = each(layout.pieces, FLOOR_PLAN_MIN_PIECE);
  return changed ? { ...layout, tables, pieces } : layout;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { layout } = state;
  switch (action.type) {
    case 'load':
      return initialEditor(action.layout);
    case 'select':
      return { ...state, selected: action.key };
    case 'dragStart':
      return { ...state, selected: action.key, before: layout };
    case 'dragEnd': {
      if (!state.before) return state;
      const { before } = state;
      const ended = { ...state, before: null };
      return before === layout ? ended : { ...change({ ...ended, layout: before }, layout) };
    }
    case 'dragCancel':
      return state.before ? { ...state, layout: state.before, before: null } : state;
    case 'place': {
      const step = action.exact ? (v: number) => Math.round(v) : (v: number) => snap(v);
      return change(
        state,
        updateItem(layout, action.key, (item, min) => {
          const next = { ...item };
          for (const side of ['x', 'y', 'width', 'height'] as const) {
            const value = action.box[side];
            if (value !== undefined && Number.isFinite(value)) next[side] = step(value);
          }
          return intoRoom(next, layout.room, min);
        }),
      );
    }
    case 'addPiece': {
      if (layout.pieces.length >= FLOOR_PLAN_MAX_PIECES) return state;
      const key = freeKey(layout, action.kind);
      const size = intoRoom(
        { x: 0, y: 0, ...PIECE_SIZES[action.kind] },
        layout.room,
        FLOOR_PLAN_MIN_PIECE,
      );
      const piece = { ...size, ...freePlace(layout, size), key, kind: action.kind };
      return {
        ...change(state, { ...layout, pieces: [...layout.pieces, piece] }),
        selected: key,
      };
    }
    case 'addTable': {
      if (
        layout.tables.length >= FLOOR_PLAN_MAX_TABLES ||
        layout.tables.some((t) => t.tableId === action.tableId)
      ) {
        return state;
      }
      const key = freeKey(layout, 't');
      const edge = action.seats > 4 ? 110 : 80;
      const size = { width: edge, height: 80 };
      const table = {
        ...size,
        ...freePlace(layout, size),
        key,
        tableId: action.tableId,
        create: null,
      };
      return {
        ...change(state, { ...layout, tables: [...layout.tables, table] }),
        selected: key,
      };
    }
    case 'rename':
      return change(state, {
        ...layout,
        tables: layout.tables.map((t) =>
          t.key === action.key && t.create
            ? { ...t, create: { ...t.create, ...action.create } }
            : t,
        ),
      });
    case 'remove': {
      const keep = (item: Item) => item.key !== action.key;
      return {
        ...change(state, {
          ...layout,
          tables: layout.tables.filter(keep),
          pieces: layout.pieces.filter(keep),
        }),
        selected: state.selected === action.key ? null : state.selected,
      };
    }
    case 'room': {
      const { room } = action;
      return change(state, {
        room,
        tables: layout.tables.map((t) => intoRoom(t, room, FLOOR_PLAN_MIN_TABLE)),
        pieces: layout.pieces.map((p) => intoRoom(p, room, FLOOR_PLAN_MIN_PIECE)),
      });
    }
    case 'replace':
      return { ...change({ ...state, before: null }, action.layout), selected: null };
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous || state.before) return state;
      return {
        ...state,
        layout: previous,
        past: state.past.slice(0, -1),
        future: [layout, ...state.future],
        selected: null,
      };
    }
    case 'redo': {
      const [next, ...future] = state.future;
      if (!next || state.before) return state;
      return { ...state, layout: next, past: [...state.past, layout], future, selected: null };
    }
  }
}

/** A saved layout without tables that left the area or went out of service. */
export function withoutGone(
  layout: FloorPlanLayout,
  tableIds: ReadonlySet<string>,
): FloorPlanLayout {
  const tables = layout.tables.filter((t) => t.tableId === null || tableIds.has(t.tableId));
  return tables.length === layout.tables.length ? layout : { ...layout, tables };
}

/**
 * New tables that exist by now (an old draft, restored after it was published once) become those tables: same name, in
 * this area, not on the plan already.
 */
export function withExisting(
  layout: FloorPlanLayout,
  areaTables: readonly { id: string; name: string }[],
): FloorPlanLayout {
  const placed = new Set(layout.tables.map((t) => t.tableId));
  const free = new Map(
    areaTables.filter((t) => !placed.has(t.id)).map((t) => [t.name, t.id] as const),
  );
  if (!layout.tables.some((t) => t.create && free.has(t.create.name))) return layout;
  return {
    ...layout,
    tables: layout.tables.map((t) => {
      const tableId = t.create ? free.get(t.create.name) : undefined;
      return tableId === undefined ? t : { ...t, tableId, create: null };
    }),
  };
}

/** Equal content; the order of an object's fields doesn't count (the database doesn't keep it). */
export function sameLayout(a: FloorPlanLayout, b: FloorPlanLayout): boolean {
  return a === b || canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, part: unknown) =>
    part !== null && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => (a < b ? -1 : 1)))
      : part,
  );
}
