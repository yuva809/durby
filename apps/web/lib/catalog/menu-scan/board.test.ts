import { checkImportRows } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  type Board,
  boardFromParsed,
  boardReducer,
  historyReducer,
  isDrinkCategory,
  toImportRows,
} from './board';
import type { ParsedCategory } from './parse';

const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
const product = (name: string, price: string, description = '') => ({
  name,
  price,
  description,
  confidence: 90,
  source: { page: 1, box },
});

const PARSED: ParsedCategory[] = [
  { name: null, suspect: false, products: [product('Bread', '2.00')] },
  { name: 'Kottu', suspect: false, products: [product('Chicken Kottu', '1300.00', 'spicy')] },
  { name: 'Beverages', suspect: false, products: [product('Ginger Beer', '350.00')] },
  { name: 'KOTTU', suspect: true, products: [product('Cheese Kottu', '1500.00')] },
];

function board(): Board {
  let n = 0;
  return boardFromParsed(PARSED, {
    defaults: { food: '7', drinks: '19' },
    uncategorized: 'Uncategorized',
    newId: () => `id${++n}`,
  });
}

const names = (b: Board) =>
  b.categories.map((c) => [c.name, c.productIds.map((id) => b.products[id]!.name)]);

describe('boardFromParsed', () => {
  it('names the unnamed category, merges same-named headings and sets VAT by drink names', () => {
    const b = board();
    expect(names(b)).toEqual([
      ['Uncategorized', ['Bread']],
      ['Kottu', ['Chicken Kottu', 'Cheese Kottu']],
      ['Beverages', ['Ginger Beer']],
    ]);
    expect(b.categories.map((c) => c.taxRate)).toEqual(['7', '7', '19']);
  });

  it.each([
    ['Beverages', true],
    ['Getränke', true],
    ['Soft Drinks', true],
    ['Hot Coffee', true],
    ['Kottu', false],
    ['Barbecue', false],
  ])('isDrinkCategory(%s) = %s', (name, drinks) => {
    expect(isDrinkCategory(name)).toBe(drinks);
  });
});

describe('boardReducer', () => {
  it('moves a product to another category at a position', () => {
    const b = board();
    const bread = b.categories[0]!.productIds[0]!;
    const kottu = b.categories[1]!.id;
    expect(
      names(
        boardReducer(b, { type: 'moveProduct', productId: bread, toCategoryId: kottu, index: 1 }),
      ),
    ).toEqual([
      ['Uncategorized', []],
      ['Kottu', ['Chicken Kottu', 'Bread', 'Cheese Kottu']],
      ['Beverages', ['Ginger Beer']],
    ]);
  });

  it('moves several products, reorders, swaps, merges and deletes categories', () => {
    let b = board();
    const [uncat, kottu, drinks] = b.categories.map((c) => c.id) as [string, string, string];
    b = boardReducer(b, {
      type: 'moveProducts',
      productIds: b.categories[1]!.productIds,
      toCategoryId: drinks,
    });
    expect(names(b)[2]).toEqual(['Beverages', ['Ginger Beer', 'Chicken Kottu', 'Cheese Kottu']]);
    b = boardReducer(b, { type: 'moveCategory', categoryId: drinks, index: 0 });
    expect(b.categories.map((c) => c.id)).toEqual([drinks, uncat, kottu]);
    b = boardReducer(b, { type: 'swapCategories', a: drinks, b: kottu });
    expect(b.categories.map((c) => c.id)).toEqual([kottu, uncat, drinks]);
    b = boardReducer(b, { type: 'mergeCategory', from: uncat, into: kottu });
    expect(names(b)).toEqual([
      ['Kottu', ['Bread']],
      ['Beverages', ['Ginger Beer', 'Chicken Kottu', 'Cheese Kottu']],
    ]);
    b = boardReducer(b, {
      type: 'deleteCategory',
      categoryId: kottu,
      uncategorized: { id: 'u', name: 'Uncategorized' },
    });
    expect(names(b)).toEqual([
      ['Beverages', ['Ginger Beer', 'Chicken Kottu', 'Cheese Kottu']],
      ['Uncategorized', ['Bread']],
    ]);
  });

  it('keeps VAT with the defaults until set by hand, also when renamed', () => {
    let b = board();
    const kottu = b.categories[1]!.id;
    const drinks = b.categories[2]!.id;
    b = boardReducer(b, { type: 'renameCategory', categoryId: kottu, name: 'Cocktails' });
    expect(b.categories[1]!.taxRate).toBe('19');
    b = boardReducer(b, { type: 'setCategoryVat', categoryId: drinks, taxRate: '0' });
    b = boardReducer(b, { type: 'setDefaults', food: '19', drinks: '20' });
    expect(b.categories.map((c) => c.taxRate)).toEqual(['19', '20', '0']);
  });

  it('edits, adds and deletes products', () => {
    let b = board();
    const kottu = b.categories[1]!.id;
    const chicken = b.categories[1]!.productIds[0]!;
    b = boardReducer(b, {
      type: 'updateProduct',
      productId: chicken,
      patch: { price: '1350.00', taxRate: '19' },
    });
    b = boardReducer(b, {
      type: 'addProduct',
      categoryId: kottu,
      product: {
        id: 'new',
        name: 'Egg Kottu',
        price: '1200.00',
        description: '',
        taxRate: null,
        confidence: 100,
        source: null,
      },
    });
    b = boardReducer(b, { type: 'deleteProducts', productIds: [b.categories[0]!.productIds[0]!] });
    expect(names(b)).toEqual([
      ['Uncategorized', []],
      ['Kottu', ['Chicken Kottu', 'Cheese Kottu', 'Egg Kottu']],
      ['Beverages', ['Ginger Beer']],
    ]);
    expect(b.products[chicken]).toMatchObject({ price: '1350.00', taxRate: '19' });
  });
});

describe('historyReducer', () => {
  it('undoes and redoes, and a new action drops the redo steps', () => {
    let h = { past: [], present: board(), future: [] } as ReturnType<typeof historyReducer>;
    const kottu = h.present.categories[1]!.id;
    h = historyReducer(h, { type: 'renameCategory', categoryId: kottu, name: 'Kotthu' });
    h = historyReducer(h, { type: 'undo' });
    expect(h.present.categories[1]!.name).toBe('Kottu');
    h = historyReducer(h, { type: 'redo' });
    expect(h.present.categories[1]!.name).toBe('Kotthu');
    h = historyReducer(h, { type: 'undo' });
    h = historyReducer(h, { type: 'renameCategory', categoryId: kottu, name: 'Roti' });
    expect(h.future).toEqual([]);
    expect(historyReducer(h, { type: 'redo' })).toBe(h);
  });
});

describe('toImportRows', () => {
  it('sends board order, the category or product VAT, and descriptions only when present', () => {
    let b = board();
    const chicken = b.categories[1]!.productIds[0]!;
    b = boardReducer(b, { type: 'updateProduct', productId: chicken, patch: { taxRate: '19' } });
    const rows = toImportRows(b);
    expect(rows).toEqual([
      { category: 'Uncategorized', name: 'Bread', price: '2.00', taxRate: '7' },
      {
        category: 'Kottu',
        name: 'Chicken Kottu',
        price: '1300.00',
        taxRate: '19',
        description: 'spicy',
      },
      { category: 'Kottu', name: 'Cheese Kottu', price: '1500.00', taxRate: '7' },
      { category: 'Beverages', name: 'Ginger Beer', price: '350.00', taxRate: '19' },
    ]);
    expect(checkImportRows(rows)).toEqual([]);
  });
});
