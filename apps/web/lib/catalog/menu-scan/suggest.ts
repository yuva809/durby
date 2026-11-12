import type { Board, BoardAction, BoardCategory } from './board';
import { DISH_GROUPS, type DishGroup, MENU_VOCABULARY } from './vocabulary';

/**
 * Suggestions for a scanned menu (docs/modules/catalog.md → Menu scan): misread words corrected
 * against a menu vocabulary and the organization's own names, existing products matched, doubtful
 * headings renamed and stray products given a category. Pure, no network.
 */

export type Suggestion =
  | { kind: 'name'; key: string; productId: string; name: string; fromCatalog: boolean }
  | { kind: 'move'; key: string; productId: string; categoryId: string; categoryName: string }
  | { kind: 'rename'; key: string; categoryId: string; name: string }
  | { kind: 'price'; key: string; productId: string; price: string };

export interface SuggestContext {
  /** The organization's products with their category names. */
  catalogProducts: readonly { name: string; category: string }[];
  catalogCategories: readonly string[];
  /** The board's name for products without a heading. */
  uncategorized: string;
  /** A dish group's category name in the user's language. */
  groupName: (group: DishGroup) => string;
}

/** Letters OCR engines confuse in menu fonts (script and serif): cheap substitutions. */
const CONFUSABLE = new Set(
  [
    'lt',
    'li',
    'l1',
    'i1',
    'ij',
    'o0',
    's5',
    'b8',
    'mn',
    'uv',
    'ce',
    'eo',
    'ao',
    'ge',
    'fe',
    'sz',
    'hb',
    'qr',
    'yr',
    'rn',
    'co',
    'ae',
    'gy',
    'kr',
    'do',
    'hk',
    'ua',
    'ei',
    'nh',
    'ft',
    'jv',
    'vo',
  ].flatMap((p) => [p, `${p[1]}${p[0]}`]),
);
/** One letter read as two or two as one. */
const SPLITS: readonly [string, string][] = [
  ['rn', 'm'],
  ['cl', 'd'],
  ['li', 'h'],
  ['ii', 'u'],
  ['vv', 'w'],
  ['in', 'm'],
];
const CONFUSED = 0.4;
/** Thin letters OCR drops (`Mid` for `Mild`): cheaper to add back than other letters. */
const THIN = new Set(['l', 'i', 't', 'f', 'j', 'r']);
const THIN_MISSING = 0.5;
/** The best correction must beat the next one by this much, or the word is left as read. */
const MARGIN = 0.19;
/** A three-letter word takes one cheap fix at most (`mil` → `mit`, `amb` → `Lamb`). */
const SHORT_LIMIT = 0.7;
/** Letters missing before the first one read: cut off at the photo's edge. */
const CUT_OFF = 0.7;

/** Lowercase without accents (`Stück` → `stuck`, `ß` → `ss`) for comparing. */
export function fold(word: string): string {
  return word.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Edit distance from what OCR read (`read`) to a known word, both folded: confusable letters,
 * split/merged letters and letters cut off at the start cost less than other edits.
 */
export function ocrDistance(read: string, known: string): number {
  const a = read;
  const b = known;
  const d: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let j = 0; j <= b.length; j++) d[0]![j] = j * CUT_OFF;
  for (let i = 1; i <= a.length; i++) d[i]![0] = i;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1]!;
      const y = b[j - 1]!;
      const substitution = x === y ? 0 : CONFUSABLE.has(x + y) ? CONFUSED : 1;
      const missing = THIN.has(y) ? THIN_MISSING : 1;
      let best = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + missing,
        d[i - 1]![j - 1]! + substitution,
      );
      if (i > 1 && j > 1 && x === b[j - 2] && a[i - 2] === y)
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      for (const [two, one] of SPLITS) {
        if (i > 1 && a.slice(i - 2, i) === two && y === one)
          best = Math.min(best, d[i - 2]![j - 1]! + CONFUSED);
        if (j > 1 && b.slice(j - 2, j) === two && x === one)
          best = Math.min(best, d[i - 1]![j - 2]! + CONFUSED);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

export interface Lexicon {
  /** Folded word → its usual spelling. */
  words: Map<string, string>;
  byLength: Map<number, string[]>;
  /** Folded words read right elsewhere on this menu: corrections towards them cost less. */
  menu?: ReadonlyMap<string, number>;
}

/** How much a word that appears elsewhere on the same menu is preferred (the menu teaches itself). */
const MENU_BONUS = 0.4;

/** The menu vocabulary plus the words of `extra` names (the organization's products, categories). */
export function buildLexicon(extra: readonly string[] = []): Lexicon {
  const words = new Map<string, string>();
  // The first built-in spelling of a word counts; the organization's own spelling wins over it.
  const add = (word: string, own: boolean) => {
    const clean = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    const key = fold(clean);
    if (key.length >= 2 && (own || !words.has(key))) words.set(key, clean);
  };
  for (const word of MENU_VOCABULARY) add(word, false);
  for (const name of extra) for (const word of name.split(/[\s/]+/)) add(word, true);
  const byLength = new Map<number, string[]>();
  for (const key of words.keys()) {
    const list = byLength.get(key.length) ?? [];
    list.push(key);
    byLength.set(key.length, list);
  }
  return { words, byLength };
}

/** A word's correction, or null when it is known, too short, a number or not clearly one word. */
export function correctWord(token: string, lexicon: Lexicon): string | null {
  const match = /^([^\p{L}]*)(.*?)([^\p{L}]*)$/u.exec(token);
  if (!match) return null;
  const [, rawPrefix = '', core = '', suffix = ''] = match;
  // An opening bracket or bar with nothing closing it is a misread letter or a speck (`[amb`).
  const prefix = /[)\]}]/.test(suffix) ? rawPrefix : rawPrefix.replace(/[[{|]/g, '');
  if (core.includes('-')) {
    const parts = core.split('-');
    const fixed = parts.map((p) => correctWord(p, lexicon) ?? p);
    return fixed.some((p, i) => p !== parts[i]) ? `${prefix}${fixed.join('-')}${suffix}` : null;
  }
  if (/[^\p{L}]/u.test(core)) return null;
  const key = fold(core);
  if (key.length < 3 || lexicon.words.has(key)) return null;
  let best: string | null = null;
  let bestCost = Infinity;
  let secondCost = Infinity;
  for (let length = key.length - 2; length <= key.length + 3; length++) {
    for (const candidate of lexicon.byLength.get(length) ?? []) {
      const cost = ocrDistance(key, candidate) - (lexicon.menu?.get(candidate) ?? 0);
      if (cost < bestCost) {
        secondCost = bestCost;
        bestCost = cost;
        best = candidate;
      } else if (cost < secondCost) {
        secondCost = cost;
      }
    }
  }
  if (best === null) return null;
  const longest = Math.max(key.length, best.length);
  const limit = key.length >= 4 ? Math.max(1, 0.34 * longest) : SHORT_LIMIT;
  if (bestCost > limit || secondCost - bestCost < MARGIN) return null;
  const spelling = lexicon.words.get(best)!;
  const cased =
    spelling !== spelling.toLowerCase() || !/^\p{Lu}/u.test(core)
      ? spelling
      : spelling[0]!.toUpperCase() + spelling.slice(1);
  return `${prefix}${cased}${suffix}`;
}

/** A name with its misread words corrected, or null when nothing changes. */
export function correctName(name: string, lexicon: Lexicon): string | null {
  const tokens = name.split(/\s+/).filter(Boolean);
  // Specks before the name: unknown one- or two-letter bits (`q nw Milagu Masala`).
  let start = 0;
  while (
    start < tokens.length - 1 &&
    fold(tokens[start]!.replace(/[^\p{L}]/gu, '')).length <= 2 &&
    !lexicon.words.has(fold(tokens[start]!.replace(/[^\p{L}]/gu, '')))
  ) {
    start++;
  }
  const fixed = tokens.slice(start).map((t) => correctWord(t, lexicon) ?? t);
  const result = fixed.join(' ');
  return result !== tokens.join(' ') ? result : null;
}

const comparable = (name: string) =>
  fold(name)
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim();

/**
 * The closest existing product name (≥ 80 % alike, preferring the same category) to the name as
 * read or as corrected; null when the name as read is already exactly an existing one.
 */
function catalogMatch(
  read: string,
  names: readonly string[],
  category: string,
  catalog: SuggestContext['catalogProducts'],
): string | null {
  let best: { name: string; score: number } | null = null;
  for (const product of catalog) {
    const known = comparable(product.name);
    for (const name of names) {
      const candidate = comparable(name);
      if (!candidate || !known) continue;
      if (candidate === known) return product.name === read ? null : product.name;
      const score =
        1 -
        ocrDistance(candidate, known) / Math.max(candidate.length, known.length) +
        (fold(product.category) === fold(category) ? 0.05 : 0);
      if (score >= 0.8 && (!best || score > best.score)) best = { name: product.name, score };
    }
  }
  return best?.name ?? null;
}

/** The dish group a name belongs to, by keyword (the first group that matches). */
export function dishGroup(name: string): DishGroup | null {
  // Category names are often plural ("Breads", "Desserts", "Getränke"): singular forms count too.
  const words = new Set(
    comparable(name)
      .split(' ')
      .flatMap((w) => [w, w.replace(/(e?s|n)$/, '')]),
  );
  for (const group of DISH_GROUPS) {
    if (group.words.some((w) => words.has(fold(w)))) return group.key;
  }
  return null;
}

/** Confidence of text read exactly (a PDF's own text, products added by hand). */
const EXACT = 100;
/** Share of a category's products that must share a dish group to suggest that as its name. */
const DOMINANT = 0.5;
/** On a menu where this share of prices ends in 0, another last digit is a misread 0. */
const ROUND_PRICES = 0.9;
/** Enough prices to tell how the menu prices. */
const MIN_PRICES = 10;

export function suggest(board: Board, context: SuggestContext, base: Lexicon): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const nameOf = new Map<string, string>();

  // First pass: the words this menu itself spells right (as read, or once corrected) …
  const menu = new Map<string, number>();
  for (const product of Object.values(board.products)) {
    const name = correctName(product.name, base) ?? product.name;
    for (const word of name.split(/[\s-]+/)) {
      const key = fold(word.replace(/[^\p{L}]/gu, ''));
      if (key.length >= 3 && base.words.has(key)) menu.set(key, MENU_BONUS);
    }
  }
  // … then every name is corrected preferring them.
  const lexicon: Lexicon = { ...base, menu };

  for (const category of board.categories) {
    for (const productId of category.productIds) {
      const product = board.products[productId];
      if (!product || product.checked) continue;
      // Text read exactly (a PDF's own text) is as printed: only existing products are matched.
      const corrected = product.confidence < EXACT ? correctName(product.name, lexicon) : null;
      const known = catalogMatch(
        product.name,
        corrected ? [product.name, corrected] : [product.name],
        category.name,
        context.catalogProducts,
      );
      const name = known ?? corrected;
      nameOf.set(productId, name ?? product.name);
      if (name && name !== product.name) {
        suggestions.push({
          kind: 'name',
          key: `name:${productId}:${name}`,
          productId,
          name,
          fromCatalog: known !== null,
        });
      }
    }
  }

  const prices = Object.values(board.products).map((p) => p.price);
  const round = prices.filter((p) => /\.\d0$/.test(p)).length;
  if (prices.length >= MIN_PRICES && round >= ROUND_PRICES * prices.length) {
    for (const category of board.categories) {
      for (const productId of category.productIds) {
        const product = board.products[productId];
        if (!product || product.checked || product.confidence >= EXACT) continue;
        if (!/^\d+\.\d[1-9]$/.test(product.price)) continue;
        const price = `${product.price.slice(0, -1)}0`;
        suggestions.push({ kind: 'price', key: `price:${productId}:${price}`, productId, price });
      }
    }
  }

  const doubtful = (c: BoardCategory) => c.suspect === true || c.name === context.uncategorized;
  const groupOf = (productId: string) =>
    dishGroup(nameOf.get(productId) ?? board.products[productId]?.name ?? '');

  for (const category of board.categories.filter(doubtful)) {
    const corrected =
      category.name === context.uncategorized ? null : correctName(category.name, lexicon);
    const firstKnown =
      corrected !== null &&
      lexicon.words.has(fold(corrected.split(/\s+/)[0]!.replace(/[^\p{L}]/gu, '')));
    const counts = new Map<DishGroup, number>();
    for (const id of category.productIds) {
      const group = groupOf(id);
      if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const dominant = top && top[1] >= DOMINANT * category.productIds.length ? top[0] : null;
    // A corrected heading that names another kind of dish than its products is a misreading.
    const headingGroup = corrected ? dishGroup(corrected) : null;
    const fits = !headingGroup || !dominant || headingGroup === dominant;
    let name: string | null = firstKnown && fits ? corrected : null;
    if (!name) {
      // Products of mixed kinds (no dominant group) have no home category to move to.
      const home =
        dominant !== null &&
        board.categories.some(
          (c) =>
            c !== category &&
            !doubtful(c) &&
            (dishGroup(c.name) === dominant ||
              fold(c.name) === fold(context.groupName(dominant))),
        );
      // Its dishes have a category already: they are moved there (below), not renamed.
      if (top && dominant && !(category.name === context.uncategorized && home)) {
        const label = context.groupName(top[0]);
        name =
          context.catalogCategories.find(
            (c) => dishGroup(c) === top[0] || fold(c) === fold(label),
          ) ?? label;
      }
    }
    if (
      name &&
      name !== category.name &&
      !board.categories.some((c) => c !== category && fold(c.name) === fold(name))
    ) {
      suggestions.push({
        kind: 'rename',
        key: `rename:${category.id}:${name}`,
        categoryId: category.id,
        name,
      });
    }
  }

  // Products without a heading whose dish has its own category on the board.
  for (const category of board.categories.filter((c) => c.name === context.uncategorized)) {
    for (const productId of category.productIds) {
      const group = groupOf(productId);
      if (!group) continue;
      const home = board.categories.find(
        (c) =>
          c !== category &&
          !doubtful(c) &&
          (dishGroup(c.name) === group || fold(c.name) === fold(context.groupName(group))),
      );
      if (home) {
        suggestions.push({
          kind: 'move',
          key: `move:${productId}:${home.id}`,
          productId,
          categoryId: home.id,
          categoryName: home.name,
        });
      }
    }
  }
  return suggestions;
}

/** The board actions that apply a suggestion. */
export function suggestionActions(suggestion: Suggestion, board: Board): BoardAction[] {
  switch (suggestion.kind) {
    case 'name':
      return [
        {
          type: 'updateProduct',
          productId: suggestion.productId,
          patch: { name: suggestion.name },
        },
      ];
    case 'rename':
      return [{ type: 'renameCategory', categoryId: suggestion.categoryId, name: suggestion.name }];
    case 'price':
      return [
        {
          type: 'updateProduct',
          productId: suggestion.productId,
          patch: { price: suggestion.price },
        },
      ];
    case 'move': {
      const target = board.categories.find((c) => c.id === suggestion.categoryId);
      return [
        {
          type: 'moveProduct',
          productId: suggestion.productId,
          toCategoryId: suggestion.categoryId,
          index: target?.productIds.length ?? 0,
        },
      ];
    }
  }
}

/** "Apply all" as one batch (one undo step). */
export function applyAll(suggestions: readonly Suggestion[], board: Board): BoardAction {
  return { type: 'batch', actions: suggestions.flatMap((s) => suggestionActions(s, board)) };
}
