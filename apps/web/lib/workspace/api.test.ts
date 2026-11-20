import { describe, expect, it } from 'vitest';
import { resultHref } from './api';

describe('resultHref', () => {
  it('opens a stock item on the Items page, searched for its name', () => {
    expect(resultHref({ type: 'stock_item', id: 'a1', title: 'Basmati rice' })).toBe(
      '/inventory/items?q=Basmati%20rice',
    );
  });

  it('opens a stock document on the Documents page', () => {
    expect(resultHref({ type: 'stock_document', id: 'd1', title: 'GRN-2026-000001' })).toBe(
      '/inventory/documents',
    );
  });

  it('opens a warehouse on the warehouses page and a branch on the branches page', () => {
    expect(resultHref({ type: 'warehouse', id: 'w1', title: 'Depot' })).toBe(
      '/inventory/warehouses',
    );
    expect(resultHref({ type: 'branch', id: 'b1', title: 'Hagelberger' })).toBe('/branches');
  });
});
