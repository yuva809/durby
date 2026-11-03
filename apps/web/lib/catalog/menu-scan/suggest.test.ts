import { describe, expect, it } from 'vitest';
import { type Board, boardFromParsed, historyReducer } from './board';
import type { ParsedCategory, ParsedProduct } from './parse';
import {
  applyAll,
  buildLexicon,
  correctName,
  correctWord,
  dishGroup,
  ocrDistance,
  suggest,
  type SuggestContext,
} from './suggest';

const lexicon = buildLexicon();

describe('ocrDistance', () => {
  it('makes confusable letters, merged letters and cut-off starts cheap', () => {
    expect(ocrDistance('mullen', 'mutton')).toBeLessThan(ocrDistance('mxxxen', 'mutton'));
    expect(ocrDistance('rnango', 'mango')).toBeLessThan(1);
    expect(ocrDistance('hicken', 'chicken')).toBeLessThan(1);
    expect(ocrDistance('mid', 'mild')).toBeLessThan(ocrDistance('mid', 'mit'));
  });
});

describe('correctWord and correctName', () => {
  it.each([
    ['Ucgclarian', 'Vegetarian'],
    ['wilh', 'with'],
    ['Yailha', 'Raitha'],
    ['Nullon', 'Mutton'],
    ['fisereme', 'Eiscreme'],
    ['(Mid)', '(Mild)'],
    ['{Heals', 'Meals'],
    ['Gluck)', 'Stück)'],
  ])('%s → %s', (read, expected) => {
    expect(correctWord(read, lexicon)).toBe(expected);
  });

  it('leaves known words, numbers and unclear words alone', () => {
    expect(correctWord('Naan', lexicon)).toBeNull();
    expect(correctWord('12,50', lexicon)).toBeNull();
    expect(correctWord('xq', lexicon)).toBeNull();
  });

  it('corrects a whole name and drops specks before it', () => {
    expect(correctName('Gulab Jaman mil fisereme', lexicon)).toBe('Gulab Jamun mit Eiscreme');
    expect(correctName('q nw Milaga Masala', lexicon)).toBe('Milagu Masala');
    expect(correctName('Garlic Naan', lexicon)).toBeNull();
  });

  it("prefers the organization's own spelling", () => {
    const own = buildLexicon(['Kotthu Roti']);
    expect(correctWord('Kotlhu', own)).toBe('Kotthu');
  });
});

describe('dishGroup', () => {
  it('finds the kind of dish by keyword', () => {
    expect(dishGroup('Garlic Naan')).toBe('breads');
    expect(dishGroup('Mango Lassi')).toBe('drinks');
    expect(dishGroup('Chicken Tikka Masala')).toBe('curries');
    expect(dishGroup('Something else')).toBeNull();
  });
});

const product = (name: string, price = '9.90'): ParsedProduct => ({
  name,
  price,
  description: '',
  confidence: 40,
  source: { page: 1, box: { x0: 0, y0: 0, x1: 10, y1: 10 } },
});

function board(parsed: ParsedCategory[]): Board {
  let n = 0;
  return boardFromParsed(parsed, {
    defaults: { food: '7', drinks: '19' },
    uncategorized: 'Uncategorized',
    newId: () => `id${++n}`,
  });
}

const context = (catalog: { name: string; category: string }[] = []): SuggestContext => ({
  catalogProducts: catalog,
  catalogCategories: [...new Set(catalog.map((p) => p.category))],
  uncategorized: 'Uncategorized',
  groupName: (g) => ({ breads: 'Brote', biryani: 'Biryani' })[g as string] ?? g,
});

describe('suggest', () => {
  it('suggests word fixes, existing products, heading names, moves and round prices', () => {
    const b = board([
      { name: null, suspect: false, products: [product('Garlic Naan', '4.50')] },
      {
        name: 'rani',
        suspect: true,
        products: [product('Chicken Biryani', '17.90'), product('Jegclable Biryani', '15.90')],
      },
      {
        name: 'Breads',
        suspect: false,
        products: [
          product('Pancer Naan', '5.20'),
          product('Butter Chiken', '16.91'),
          ...['3.90', '4.50', '5.50', '6.50', '5.50', '8.20', '5.20'].map((p) =>
            product('Naan', p),
          ),
        ],
      },
    ]);
    const suggestions = suggest(
      b,
      context([{ name: 'Butter Chicken', category: 'Mains' }]),
      lexicon,
    );
    const name = (n: string) =>
      b.categories.flatMap((c) => c.productIds).find((id) => b.products[id]!.name === n)!;

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'name',
          productId: name('Jegclable Biryani'),
          name: 'Vegetable Biryani',
          fromCatalog: false,
        }),
        expect.objectContaining({
          kind: 'name',
          productId: name('Pancer Naan'),
          name: 'Paneer Naan',
        }),
        expect.objectContaining({
          kind: 'name',
          productId: name('Butter Chiken'),
          name: 'Butter Chicken',
          fromCatalog: true,
        }),
        expect.objectContaining({
          kind: 'rename',
          categoryId: b.categories[1]!.id,
          name: 'Biryani',
        }),
        expect.objectContaining({
          kind: 'move',
          productId: name('Garlic Naan'),
          categoryId: b.categories[2]!.id,
        }),
        expect.objectContaining({
          kind: 'price',
          productId: name('Butter Chiken'),
          price: '16.90',
        }),
      ]),
    );
  });

  it('applies all suggestions as one undo step and marks fixed products checked', () => {
    const b = board([
      { name: 'Desserts', suspect: false, products: [product('Gulab Jaman mil fisereme')] },
    ]);
    const suggestions = suggest(b, context(), lexicon);
    const history = historyReducer({ past: [], present: b, future: [] }, applyAll(suggestions, b));
    const fixed = Object.values(history.present.products)[0]!;
    expect(fixed).toMatchObject({ name: 'Gulab Jamun mit Eiscreme', checked: true });
    expect(history.past).toHaveLength(1);
    expect(historyReducer(history, { type: 'undo' }).present).toBe(b);
  });

  it('suggests nothing for products someone already checked', () => {
    const b = board([{ name: 'Desserts', suspect: false, products: [product('Gulab Jaman')] }]);
    const id = b.categories[0]!.productIds[0]!;
    const checked = { ...b, products: { [id]: { ...b.products[id]!, checked: true } } };
    expect(suggest(checked, context(), lexicon)).toEqual([]);
  });
});
