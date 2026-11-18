// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { CategoriesPage } from './categories-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const id = (n: number) => `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
const FOOD = { id: id(1), name: 'Food', sortOrder: 0, station: 'kitchen', archivedAt: null };
const DRINKS = { id: id(2), name: 'Drinks', sortOrder: 1, station: 'bar', archivedAt: null };
const product = (n: number, categoryId: string, archivedAt: string | null = null) => ({
  id: id(10 + n),
  categoryId,
  name: `P${n}`,
  menuNumber: null,
  description: null,
  price: '1.00',
  taxRate: '7.00',
  sortOrder: 0,
  archivedAt,
});

function signedInAs(
  role: SystemRole,
  permissions?: string[],
  features = ['catalog', 'inventory', 'pos'],
) {
  mockState.session = sessionFixture({
    activePermissions: permissions ?? [...systemRolePermissions(role)],
    activeFeatures: features,
  });
}

function api() {
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const path = input.replace(/\?.*$/, '');
    if (path.endsWith('/categories'))
      return Promise.resolve(Response.json({ data: [FOOD, DRINKS] }));
    return Promise.resolve(
      Response.json({
        data: [
          product(1, FOOD.id),
          product(2, FOOD.id),
          product(3, FOOD.id, '2026-11-01T00:00:00Z'),
          product(4, DRINKS.id),
        ],
      }),
    );
  });
}

describe('/catalog/categories (ADR 0044)', () => {
  it('lists the categories in order with their active product counts', async () => {
    signedInAs('owner');
    api();
    render(<CategoriesPage />);
    const lines = await screen.findAllByTestId('category-line');
    expect(lines.map((l) => l.dataset.name)).toEqual(['Food', 'Drinks']);
    expect(await within(lines[0]!).findByText('Products: 2')).toBeTruthy();
    expect(within(lines[1]!).getByText('Products: 1')).toBeTruthy();
    expect(screen.getByTestId('category-create')).toBeTruthy();
    expect(screen.getAllByTestId('category-drag')).toHaveLength(2);
  });

  it('is read-only without catalog.products.edit', async () => {
    signedInAs('staff', ['catalog.products.read']);
    api();
    render(<CategoriesPage />);
    await screen.findAllByTestId('category-line');
    expect(screen.queryByTestId('category-create')).toBeNull();
    expect(screen.queryByTestId('category-edit')).toBeNull();
    expect(screen.queryByTestId('category-drag')).toBeNull();
  });

  it('shows no access without catalog.products.read', () => {
    signedInAs('staff', []);
    render(<CategoriesPage />);
    expect(screen.queryByTestId('category-line')).toBeNull();
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });

  it('without the till (AsiaMight): stock item counts, secondary categories under their parent, no stations (ADR 0048)', async () => {
    signedInAs('owner', undefined, ['catalog', 'inventory']);
    const RICE = { ...FOOD, id: id(3), name: 'Rice', parentId: FOOD.id, description: 'Long grain' };
    const stockItem = (n: number, categoryId: string | null) => ({
      id: id(40 + n),
      name: `Item ${n}`,
      sku: null,
      unit: 'pc',
      minQuantity: null,
      parentItemId: null,
      variantValues: [],
      salePrice: null,
      categoryId,
      archivedAt: null,
    });
    mockState.store.apiFetch.mockImplementation((input: string) => {
      const path = input.replace(/\?.*$/, '');
      if (path.endsWith('/categories'))
        return Promise.resolve(Response.json({ data: [FOOD, RICE, DRINKS] }));
      if (path === '/api/v1/inventory/items')
        return Promise.resolve(
          Response.json({
            data: [stockItem(1, FOOD.id), stockItem(2, RICE.id), stockItem(3, RICE.id)],
          }),
        );
      return Promise.resolve(Response.json({ data: [] }));
    });
    render(<CategoriesPage />);
    const lines = await screen.findAllByTestId('category-line');
    expect(lines.map((l) => l.dataset.name)).toEqual(['Food', 'Rice', 'Drinks']);
    expect(await within(lines[1]!).findByText('2 items')).toBeTruthy();
    expect(within(lines[0]!).getByText('1 items')).toBeTruthy();
    expect(within(lines[1]!).getByTestId('category-description-text').textContent).toBe(
      'Long grain',
    );
    // Only top-level categories drag; no kitchen/bar badge without the till.
    expect(screen.getAllByTestId('category-drag')).toHaveLength(2);
    expect(screen.queryByText('Bar')).toBeNull();
  });
});
