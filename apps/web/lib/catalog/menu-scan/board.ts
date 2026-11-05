import type { ImportProductRow } from '@durby/shared';
import type { Box, ParsedCategory } from './parse';

/**
 * The review board of a menu scan (docs/modules/catalog.md → Menu scan): categories in order,
 * each with its products in order. Pure reducer with undo/redo; the page renders it and turns it
 * into import rows. Prices stay decimal text (rule 6).
 */

export interface BoardProduct {
  id: string;
  /** Menu number (ADR 0029); '' for none. */
  number: string;
  name: string;
  price: string;
  description: string;
  /** null: the category's rate. */
  taxRate: string | null;
  /** OCR confidence 0–100; 100 for products added by hand. */
  confidence: number;
  /** Edited or a suggestion applied: someone looked at it, whatever the OCR confidence. */
  checked?: boolean;
  source: { page: number; box: Box } | null;
}

export interface BoardCategory {
  id: string;
  name: string;
  taxRate: string;
  /** True while the rate follows the board's default (changing a default updates it). */
  vatFromDefault: boolean;
  drinks: boolean;
  productIds: string[];
  /** The heading as read is doubtful (cut off, very short, low confidence) until renamed. */
  suspect?: boolean;
}

export interface Board {
  categories: BoardCategory[];
  products: Record<string, BoardProduct>;
  defaults: { food: string; drinks: string };
}

export type BoardAction =
  | { type: 'moveProduct'; productId: string; toCategoryId: string; index: number }
  | { type: 'moveProducts'; productIds: string[]; toCategoryId: string }
  | { type: 'moveCategory'; categoryId: string; index: number }
  | { type: 'swapCategories'; a: string; b: string }
  | { type: 'renameCategory'; categoryId: string; name: string }
  | { type: 'mergeCategory'; from: string; into: string }
  | { type: 'deleteCategory'; categoryId: string; uncategorized: { id: string; name: string } }
  | { type: 'addCategory'; category: { id: string; name: string } }
  | { type: 'setCategoryVat'; categoryId: string; taxRate: string }
  | { type: 'setDefaults'; food: string; drinks: string }
  | { type: 'updateProduct'; productId: string; patch: Partial<Omit<BoardProduct, 'id'>> }
  | { type: 'addProduct'; categoryId: string; product: BoardProduct }
  | { type: 'deleteProducts'; productIds: string[] }
  /** Several actions as one undo step ("Apply all suggestions"). */
  | { type: 'batch'; actions: BoardAction[] };

/** OCR confidence below this, on a product nobody has checked yet, is shown as "to check". */
export const LOW_CONFIDENCE = 70;

export const needsCheck = (product: BoardProduct): boolean =>
  !product.checked && product.confidence < LOW_CONFIDENCE;

/** Category names that are drinks get the drinks rate (English and German menus). */
const DRINK_WORDS =
  /\b(drinks?|beverages?|getränke?|juices?|beers?|bier|wines?|wein|cocktails?|mocktails?|soft|coffee|kaffee|teas?|tee|shakes?|smoothies?|sodas?|waters?|wasser|lassi|spirits|liquors?|arrack|sake|soju|bar)\b/i;

export function isDrinkCategory(name: string): boolean {
  return DRINK_WORDS.test(name);
}

/** A board from the parser's output; `newId` makes ids (tests pass a counter). */
export function boardFromParsed(
  parsed: readonly ParsedCategory[],
  options: { defaults: Board['defaults']; uncategorized: string; newId: () => string },
): Board {
  const products: Record<string, BoardProduct> = {};
  const categories = parsed.map((c): BoardCategory => {
    const name = c.name ?? options.uncategorized;
    const drinks = isDrinkCategory(name);
    const productIds = c.products.map((p) => {
      const id = options.newId();
      products[id] = { id, ...p, number: p.number ?? '', taxRate: null };
      return id;
    });
    return {
      id: options.newId(),
      name,
      drinks,
      taxRate: drinks ? options.defaults.drinks : options.defaults.food,
      vatFromDefault: true,
      productIds,
      suspect: c.suspect,
    };
  });
  return { categories: mergeSameNames(categories), products, defaults: options.defaults };
}

/** Two headings with the same name (front and back of a menu) become one column. */
function mergeSameNames(categories: BoardCategory[]): BoardCategory[] {
  const byName = new Map<string, BoardCategory>();
  const out: BoardCategory[] = [];
  for (const c of categories) {
    const key = c.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.productIds.push(...c.productIds);
      existing.suspect = existing.suspect && c.suspect;
    } else {
      byName.set(key, c);
      out.push(c);
    }
  }
  return out;
}

const without = (ids: string[], remove: ReadonlySet<string>) => ids.filter((id) => !remove.has(id));

export function boardReducer(board: Board, action: BoardAction): Board {
  const mapCategories = (fn: (c: BoardCategory) => BoardCategory) => ({
    ...board,
    categories: board.categories.map(fn),
  });
  switch (action.type) {
    case 'moveProduct': {
      const moved = new Set([action.productId]);
      return mapCategories((c) => {
        const ids = without(c.productIds, moved);
        if (c.id !== action.toCategoryId) return { ...c, productIds: ids };
        const index = Math.max(0, Math.min(action.index, ids.length));
        return {
          ...c,
          productIds: [...ids.slice(0, index), action.productId, ...ids.slice(index)],
        };
      });
    }
    case 'moveProducts': {
      const moved = new Set(action.productIds);
      return mapCategories((c) =>
        c.id === action.toCategoryId
          ? { ...c, productIds: [...without(c.productIds, moved), ...action.productIds] }
          : { ...c, productIds: without(c.productIds, moved) },
      );
    }
    case 'moveCategory': {
      const from = board.categories.findIndex((c) => c.id === action.categoryId);
      if (from < 0) return board;
      const rest = board.categories.filter((c) => c.id !== action.categoryId);
      const index = Math.max(0, Math.min(action.index, rest.length));
      return {
        ...board,
        categories: [...rest.slice(0, index), board.categories[from]!, ...rest.slice(index)],
      };
    }
    case 'swapCategories': {
      const a = board.categories.findIndex((c) => c.id === action.a);
      const b = board.categories.findIndex((c) => c.id === action.b);
      if (a < 0 || b < 0 || a === b) return board;
      const categories = [...board.categories];
      [categories[a], categories[b]] = [categories[b]!, categories[a]!];
      return { ...board, categories };
    }
    case 'renameCategory':
      return mapCategories((c) => {
        if (c.id !== action.categoryId) return c;
        const drinks = isDrinkCategory(action.name);
        const taxRate = c.vatFromDefault
          ? drinks
            ? board.defaults.drinks
            : board.defaults.food
          : c.taxRate;
        return { ...c, name: action.name, drinks, taxRate, suspect: false };
      });
    case 'mergeCategory': {
      const from = board.categories.find((c) => c.id === action.from);
      if (!from || action.from === action.into) return board;
      return {
        ...board,
        categories: board.categories
          .filter((c) => c.id !== action.from)
          .map((c) =>
            c.id === action.into ? { ...c, productIds: [...c.productIds, ...from.productIds] } : c,
          ),
      };
    }
    case 'deleteCategory': {
      const gone = board.categories.find((c) => c.id === action.categoryId);
      if (!gone) return board;
      const rest = board.categories.filter((c) => c.id !== action.categoryId);
      if (gone.productIds.length === 0) return { ...board, categories: rest };
      const target = rest.find((c) => c.id === action.uncategorized.id);
      return {
        ...board,
        categories: target
          ? rest.map((c) =>
              c.id === target.id ? { ...c, productIds: [...c.productIds, ...gone.productIds] } : c,
            )
          : [
              ...rest,
              {
                id: action.uncategorized.id,
                name: action.uncategorized.name,
                drinks: false,
                taxRate: board.defaults.food,
                vatFromDefault: true,
                productIds: gone.productIds,
              },
            ],
      };
    }
    case 'addCategory': {
      const drinks = isDrinkCategory(action.category.name);
      return {
        ...board,
        categories: [
          ...board.categories,
          {
            ...action.category,
            drinks,
            taxRate: drinks ? board.defaults.drinks : board.defaults.food,
            vatFromDefault: true,
            productIds: [],
          },
        ],
      };
    }
    case 'setCategoryVat':
      return mapCategories((c) =>
        c.id === action.categoryId ? { ...c, taxRate: action.taxRate, vatFromDefault: false } : c,
      );
    case 'setDefaults': {
      const defaults = { food: action.food, drinks: action.drinks };
      return {
        ...board,
        defaults,
        categories: board.categories.map((c) =>
          c.vatFromDefault ? { ...c, taxRate: c.drinks ? defaults.drinks : defaults.food } : c,
        ),
      };
    }
    case 'updateProduct': {
      const current = board.products[action.productId];
      if (!current) return board;
      return {
        ...board,
        products: {
          ...board.products,
          [action.productId]: { ...current, ...action.patch, checked: true },
        },
      };
    }
    case 'batch':
      return action.actions.reduce(boardReducer, board);
    case 'addProduct':
      return {
        ...board,
        products: { ...board.products, [action.product.id]: action.product },
        categories: board.categories.map((c) =>
          c.id === action.categoryId
            ? { ...c, productIds: [...c.productIds, action.product.id] }
            : c,
        ),
      };
    case 'deleteProducts': {
      const gone = new Set(action.productIds);
      const products = { ...board.products };
      for (const id of gone) delete products[id];
      return {
        ...board,
        products,
        categories: board.categories.map((c) => ({
          ...c,
          productIds: without(c.productIds, gone),
        })),
      };
    }
  }
}

/** Undo/redo around the board: every action is one step; at most `HISTORY` steps back. */
export interface BoardHistory {
  past: Board[];
  present: Board;
  future: Board[];
}

const HISTORY = 100;

export type HistoryAction =
  BoardAction | { type: 'undo' } | { type: 'redo' } | { type: 'reset'; board: Board };

export function historyReducer(state: BoardHistory, action: HistoryAction): BoardHistory {
  switch (action.type) {
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case 'redo': {
      const [next, ...future] = state.future;
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future };
    }
    case 'reset':
      return { past: [], present: action.board, future: [] };
    default: {
      const present = boardReducer(state.present, action);
      if (present === state.present) return state;
      return { past: [...state.past, state.present].slice(-HISTORY), present, future: [] };
    }
  }
}

/**
 * The rows for `POST /catalog/products/import`, in board order. A description is sent only when
 * the scan has one, so importing never clears an existing product's description.
 */
export function toImportRows(board: Board): ImportProductRow[] {
  // Numbers are unique (ADR 0029): a number read twice stays on its first product only.
  const seen = new Set<string>();
  return board.categories.flatMap((c) =>
    c.productIds.flatMap((id) => {
      const p = board.products[id];
      if (!p) return [];
      const description = p.description.trim();
      const read = p.number.trim();
      const number = read && !seen.has(read.toLowerCase()) ? read : '';
      if (number) seen.add(number.toLowerCase());
      return [
        {
          category: c.name.trim(),
          name: p.name.trim(),
          price: p.price.trim(),
          taxRate: (p.taxRate ?? c.taxRate).trim(),
          ...(description && { description }),
          ...(number && { number }),
          // Drink sections print at the bar when the import creates them (ADR 0029).
          ...(c.drinks && { station: 'bar' as const }),
        },
      ];
    }),
  );
}
