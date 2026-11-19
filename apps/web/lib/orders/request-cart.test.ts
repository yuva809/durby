import type { RequestAvailability } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  availableText,
  boxesOf,
  piecesOf,
  piecesPerBox,
  beyondStock,
  canAddMore,
  cartLines,
  cartReady,
  categoriesOf,
  decrement,
  increment,
  parseStoredCart,
  requestLines,
  setQuantity,
  shownItems,
  withinStock,
} from './request-cart';

const id = (n: number) => `0190a000-0000-7000-8000-0000000053${String(n).padStart(2, '0')}`;
const FISH = id(90);
const RICE = id(91);
const item = (
  n: number,
  name: string,
  available: string,
  categoryId: string | null,
  categoryName: string | null,
): RequestAvailability => ({
  itemId: id(n),
  itemName: name,
  sku: `S-${n}`,
  unit: 'pc',
  available,
  categoryId,
  categoryName,
  expiresOn: null,
  brand: null,
  packCount: null,
  packSize: null,
  packUnit: null,
});

const ITEMS = [
  item(1, 'Tilapia', '0.000', FISH, 'Frozen fish'),
  item(2, 'Catfish 4kg', '50.000', FISH, 'Frozen fish'),
  item(3, 'Basmati 5kg', '12.000', RICE, 'Rice'),
  item(4, 'Tape', '3.000', null, null),
];

describe('request cart (ADR 0053)', () => {
  it('adds, counts up and down, and drops an item at zero', () => {
    let cart = increment({}, id(2));
    cart = increment(cart, id(2));
    expect(cart).toEqual({ [id(2)]: '2' });
    cart = decrement(cart, id(2));
    expect(cart).toEqual({ [id(2)]: '1' });
    expect(decrement(cart, id(2))).toEqual({});
    expect(increment({ [id(2)]: '1,5' }, id(2))).toEqual({ [id(2)]: '2.5' });
  });

  it('keeps what is typed, drops "0", and checks quantities before sending', () => {
    let cart = setQuantity({ [id(2)]: '2' }, id(2), '');
    expect(cart).toEqual({ [id(2)]: '' });
    expect(cartReady(cartLines(cart, ITEMS))).toBe(false);
    cart = setQuantity(cart, id(2), '2,5');
    cart = setQuantity(cart, id(3), '1');
    expect(cartReady(cartLines(cart, ITEMS))).toBe(true);
    expect(requestLines(cartLines(cart, ITEMS))).toEqual([
      { itemId: id(2), quantity: '2.5' },
      { itemId: id(3), quantity: '1' },
    ]);
    expect(setQuantity(cart, id(3), '0')).toEqual({ [id(2)]: '2,5' });
    expect(cartReady(cartLines({ [id(2)]: '1.23456' }, ITEMS))).toBe(false);
  });

  it('never asks for more than the warehouse has', () => {
    // Tape: 3 there.
    let cart = increment({}, id(4), '3.000');
    cart = increment(cart, id(4), '3.000');
    cart = increment(cart, id(4), '3.000');
    expect(cart).toEqual({ [id(4)]: '3' });
    expect(increment(cart, id(4), '3.000')).toBe(cart);
    expect(canAddMore('3', '3.000')).toBe(false);
    expect(canAddMore('2', '3.000')).toBe(true);
    // Below a whole step to the limit; nothing there, nothing to add.
    expect(increment({ [id(4)]: '2.5' }, id(4), '3.000')).toEqual({ [id(4)]: '3' });
    expect(increment({}, id(1), '0.000')).toEqual({});
    expect(increment({}, id(1), '-2.000')).toEqual({});
    // Typed beyond it: not sent, and named.
    const typed = setQuantity({}, id(4), '4');
    expect(withinStock('4', '3.000')).toBe(false);
    expect(withinStock('3', '3.000')).toBe(true);
    expect(cartReady(cartLines(typed, ITEMS))).toBe(false);
    expect(beyondStock(cartLines(typed, ITEMS)).map((l) => l.item.itemName)).toEqual(['Tape']);
    expect(availableText('-1.000')).toBe('0');
    expect(availableText('2.500')).toBe('2.5');
  });

  it('drops lines whose item is no longer offered', () => {
    expect(cartLines({ [id(2)]: '1', [id(99)]: '4' }, ITEMS).map((l) => l.item.itemId)).toEqual([
      id(2),
    ]);
  });

  it('lists categories by name with counts, Other last', () => {
    expect(categoriesOf(ITEMS)).toEqual([
      { id: FISH, name: 'Frozen fish', count: 2 },
      { id: RICE, name: 'Rice', count: 1 },
      { id: '', name: null, count: 1 },
    ]);
  });

  it('shows a category or all, matches name or SKU, in stock first', () => {
    expect(shownItems(ITEMS, FISH, '').map((i) => i.itemName)).toEqual(['Catfish 4kg', 'Tilapia']);
    expect(shownItems(ITEMS, null, 's-3').map((i) => i.itemName)).toEqual(['Basmati 5kg']);
    expect(shownItems(ITEMS, '', '').map((i) => i.itemName)).toEqual(['Tape']);
  });

  it('reads a stored cart safely', () => {
    expect(parseStoredCart(null)).toEqual({});
    expect(parseStoredCart('not json')).toEqual({});
    expect(parseStoredCart('[1]')).toEqual({});
    expect(parseStoredCart(JSON.stringify({ [id(2)]: '3', bad: '1', [id(3)]: 4 }))).toEqual({
      [id(2)]: '3',
    });
  });

  it('orders by the box: whole boxes within what is there, kept as pieces (ADR 0065)', () => {
    expect(piecesPerBox({ unit: 'pc', packCount: 12 })).toBe(12);
    expect(piecesPerBox({ unit: 'pc', packCount: 1 })).toBeNull();
    expect(piecesPerBox({ unit: 'kg', packCount: 12 })).toBeNull();
    // Catfish: 50 there, 12 a box.
    let cart = increment({}, id(2), '50.000', 12);
    cart = increment(cart, id(2), '50.000', 12);
    expect(cart).toEqual({ [id(2)]: '24' });
    expect(boxesOf('24', 12)).toBe('2');
    expect(piecesOf('3', 12)).toBe('36');
    expect(piecesOf('x', 12)).toBeNull();
    // A fifth box (60) is more than there is.
    cart = increment(increment(cart, id(2), '50.000', 12), id(2), '50.000', 12);
    expect(cart).toEqual({ [id(2)]: '48' });
    expect(increment(cart, id(2), '50.000', 12)).toBe(cart);
    expect(canAddMore('48', '50.000', 12)).toBe(false);
    expect(decrement(cart, id(2), 12)).toEqual({ [id(2)]: '36' });
    expect(decrement({ [id(2)]: '12' }, id(2), 12)).toEqual({});
  });
});
