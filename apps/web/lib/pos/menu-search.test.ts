import type { Product } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { enterTarget, searchMenu } from './menu-search';

const FOOD = 'food';
const DRINKS = 'drinks';
const product = (name: string, menuNumber: string | null, categoryId = FOOD): Product => ({
  id: name,
  categoryId,
  name,
  menuNumber,
  description: null,
  price: '5.00',
  taxRate: '7.00',
  sortOrder: 0,
  archivedAt: null,
});
const MENU = [
  product('Curry', '1'),
  product('Biryani', '12'),
  product('Dal 12', null),
  product('Lassi', '12a', DRINKS),
  product('Naan', '7'),
];
const names = (list: Product[]) => list.map((p) => p.name);

describe('searchMenu (ADR 0029)', () => {
  it('puts the exact number first and matches numbers by their start and names anywhere', () => {
    const result = searchMenu(MENU, '12', null);
    expect(result.exact?.name).toBe('Biryani');
    expect(names(result.matching)).toEqual(['Dal 12', 'Lassi']);
    expect(enterTarget(result)?.name).toBe('Biryani');
  });

  it('ignores case and spaces, and finds the exact number outside the chosen category', () => {
    const result = searchMenu(MENU, ' 12A ', FOOD);
    expect(result.exact?.name).toBe('Lassi');
    expect(result.matching).toEqual([]);
  });

  it('adds the only match by name; nothing when several match', () => {
    expect(enterTarget(searchMenu(MENU, 'naa', null))?.name).toBe('Naan');
    expect(enterTarget(searchMenu(MENU, 'a', null))).toBeNull();
    expect(enterTarget(searchMenu(MENU, '', null))).toBeNull();
  });

  it('lists everything of the category without a query', () => {
    expect(names(searchMenu(MENU, '', DRINKS).matching)).toEqual(['Lassi']);
  });
});
