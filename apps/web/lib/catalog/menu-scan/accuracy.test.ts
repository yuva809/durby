import { describe, expect, it } from 'vitest';
import { boardFromParsed, boardReducer } from './board';
import fixture from './fixtures/two-column-menu.ocr.json';
import { joinRows, type OcrWord, orderColumns, parseMenu, segmentLine } from './parse';
import { applyAll, buildLexicon, fold, suggest } from './suggest';

/**
 * Accuracy of the whole reading pipeline on a real photographed menu (docs/modules/catalog.md →
 * Menu scan): OCR words as captured once → rows and columns → parse → "Apply all suggestions".
 * The thresholds are what the pipeline reaches today, so a change that reads worse fails here.
 */

/** The menu as printed: category, name, price (the left column's first heading is cut off). */
const TRUTH: [string, string, string][] = [
  ['A', 'Chicken Vindaloo (Mittel-scharf)', '16.90'],
  ['A', 'Butter Chicken (Mild)', '16.90'],
  ['A', 'Gongura Kodi (Mild)', '16.90'],
  ['A', 'Chicken Pepper Masala (Mild)', '16.90'],
  ['A', 'Goa Mango Chicken (Sweet and mild)', '16.90'],
  ['A', 'Chicken Tikka Masala (Mild)', '16.90'],
  ['Lamm', 'Chettinad Mutton Curry (Mittel-scharf)', '18.90'],
  ['Lamm', 'Mutton Milagu Masala (Scharf)', '18.90'],
  ['Lamm', 'Gongura Mutton (Medium spicy and Sour)', '18.90'],
  ['Lamm', 'Mutton Kuruma (Mild)', '18.90'],
  ['Lamm', 'Mutton Vindaloo (Mild)', '18.90'],
  ['Lamm', 'Beef Milagu Masala (Mild)', '18.90'],
  ['Biryani', 'Vegetable Biryani', '15.90'],
  ['Biryani', 'Chicken Biryani', '17.90'],
  ['Biryani', 'Mutton Biryani', '18.90'],
  ['Tandoori', 'Paneer Tikka', '17.90'],
  ['Tandoori', 'Tandoori Prawn', '17.90'],
  ['Tandoori', 'Tandoori Chicken (with bone)', '16.90'],
  ['Breads', 'Naan', '3.90'],
  ['Breads', 'Garlic Naan', '4.50'],
  ['Breads', 'Onion-Chilli Naan', '4.50'],
  ['Breads', 'Paneer Naan', '5.20'],
  ['Breads', 'Parotta (2 Stück)', '5.50'],
  ['Breads', 'Poori (3 Stück)', '6.50'],
  ['Breads', 'Chapathi (2 Stück)', '5.50'],
  ['Desserts', 'Kesari', '5.20'],
  ['Desserts', 'Gulab Jamun mit Eiscreme', '8.20'],
  ['Desserts', 'Carrot Halwa', '5.20'],
  ['Desserts', 'Paal Payasam', '5.20'],
  ['Desserts', 'Sarkarai Pongal', '5.20'],
  ['Desserts', 'Buffet (Wochentage)', '12.90'],
  ['Weekend', 'South Indian Vegetarian Meals', '14.90'],
  ['Weekend', 'South Indian Non Vegetarian Meals', '16.90'],
  ['Weekend', 'House Chicken Dum Biriyani', '17.90'],
  ['Weekend', 'House Mutton Dum Biriyani', '19.90'],
  ['Weekend', 'Poori with Kuruma and Raitha', '14.90'],
  ['Weekend', 'Chapathi with Kuruma and Raitha', '14.90'],
  ['Weekend', 'Plain Parotta (Served with gravy and raitha)', '14.90'],
  ['Weekend', 'Vegetable Kothu Parotta', '12.90'],
  ['Weekend', 'Chicken Kothu Parotta', '14.90'],
  ['Weekend', 'Lamb Kothu Parotta', '15.90'],
  ['Weekend', 'Idly - 3 pieces', '9.50'],
  ['Weekend', 'Idiyappam - 3 pieces', '9.50'],
];

/** Names compared as a person would: case, accents and punctuation aside. */
const same = (a: string, b: string) =>
  fold(a)
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim() ===
  fold(b)
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim();

function scan() {
  const lines = fixture.lines.flatMap((l) => segmentLine(l.words as OcrWord[], 1, l.strip));
  const parsed = parseMenu(orderColumns(joinRows(lines), fixture.width));
  let n = 0;
  const board = boardFromParsed(parsed, {
    defaults: { food: '7', drinks: '19' },
    uncategorized: 'Uncategorized',
    newId: () => `id${++n}`,
  });
  const suggestions = suggest(
    board,
    {
      catalogProducts: [],
      catalogCategories: [],
      uncategorized: 'Uncategorized',
      groupName: (g) => g[0]!.toUpperCase() + g.slice(1),
    },
    buildLexicon(),
  );
  return { board, after: boardReducer(board, applyAll(suggestions, board)) };
}

function score(board: ReturnType<typeof scan>['after']) {
  const products = board.categories.flatMap((c) =>
    c.productIds.map((id) => ({ ...board.products[id]!, category: c.id })),
  );
  // Reading order is kept, so the nth product read is the nth on the menu.
  const pairs = TRUTH.map((truth, i) => ({ truth, read: products[i] }));
  const byCategory = new Map<string, Map<string, number>>();
  for (const { truth, read } of pairs) {
    if (!read) continue;
    const counts = byCategory.get(read.category) ?? new Map<string, number>();
    counts.set(truth[0], (counts.get(truth[0]) ?? 0) + 1);
    byCategory.set(read.category, counts);
  }
  const majority = (category: string) =>
    [...(byCategory.get(category) ?? new Map<string, number>()).entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
  return {
    found: products.length,
    names: pairs.filter(({ truth, read }) => read && same(read.name, truth[1])).length,
    prices: pairs.filter(({ truth, read }) => read?.price === truth[2]).length,
    grouped: pairs.filter(({ truth, read }) => read && majority(read.category) === truth[0]).length,
  };
}

describe('menu scan accuracy (two-column photo, script-font names)', () => {
  const { board, after } = scan();

  it('finds every product with its price and category', () => {
    const result = score(after);
    expect(result.found).toBe(TRUTH.length);
    expect(result.prices).toBe(TRUTH.length);
    expect(result.grouped).toBe(TRUTH.length);
  });

  it('gets most names exactly right once the suggestions are applied', () => {
    const before = score(board).names;
    const result = score(after).names;
    console.info(
      `menu scan: exact names ${before} → ${result}, prices ${score(after).prices} of ${TRUTH.length}`,
    );
    expect(result).toBeGreaterThan(before);
    expect(result).toBeGreaterThanOrEqual(30);
  });
});
