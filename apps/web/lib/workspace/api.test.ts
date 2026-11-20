import { describe, expect, it } from 'vitest';
import { resultHref } from './api';

describe('resultHref', () => {
  it('opens a stock item on the Items page, searched for its name', () => {
    expect(resultHref({ type: 'stock_item', id: 'a1', title: 'Basmati rice' })).toBe(
      '/inventory/items?q=Basmati%20rice',
    );
  });
});
