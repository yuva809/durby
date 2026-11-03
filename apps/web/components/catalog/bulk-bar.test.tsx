// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { CatalogPage } from './catalog-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const id = (n: number) => `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
const FOOD = { id: id(1), name: 'Food', sortOrder: 0, archivedAt: null };
const DRINKS = { id: id(2), name: 'Drinks', sortOrder: 1, archivedAt: null };
const product = (n: number, name: string, categoryId: string, price: string) => ({
  id: id(10 + n),
  categoryId,
  name,
  description: null,
  price,
  taxRate: '7.00',
  sortOrder: 0,
  archivedAt: null,
});
const SOUP = product(1, 'Soup', FOOD.id, '10.00');
const WATER = product(2, 'Water', DRINKS.id, '2.50');

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog'],
  });
}

/** Answers the lists and the two bulk routes; records the writes. */
function api(bulk: Record<string, unknown> = {}) {
  const writes: { path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const path = input.replace(/\?.*$/, '');
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(init.body as string) });
      return Promise.resolve(
        Response.json(bulk[path] ?? { updated: [], deleted: [], kept: [], productsDeleted: 0 }),
      );
    }
    if (path.endsWith('/categories'))
      return Promise.resolve(Response.json({ data: [FOOD, DRINKS] }));
    return Promise.resolve(Response.json({ data: [SOUP, WATER] }));
  });
  return writes;
}

const pick = async (name: string) => userEvent.click(await screen.findByLabelText(name));

describe('bulk actions on the catalog page', () => {
  it('offers no selection without catalog.products.manage', async () => {
    signedInAs('staff');
    api();
    render(<CatalogPage />);
    await screen.findAllByTestId('product-row');
    expect(screen.queryByTestId('product-pick')).toBeNull();
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('selects all shown products and counts them', async () => {
    signedInAs('owner');
    api();
    render(<CatalogPage />);
    await userEvent.click(await screen.findByLabelText('Select all shown products'));
    expect(within(screen.getByTestId('bulk-bar')).getByText('2 selected')).toBeTruthy();
    await userEvent.click(screen.getByTestId('bulk-clear'));
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('previews and sends a percent price change', async () => {
    signedInAs('owner');
    const writes = api();
    render(<CatalogPage />);
    await pick('Select Soup');
    await pick('Select Water');
    await userEvent.click(screen.getByTestId('bulk-price'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Value'), '10');
    expect(within(dialog).getByText('Soup: 10.00 → 11.00')).toBeTruthy();
    expect(within(dialog).getByText('Water: 2.50 → 2.75')).toBeTruthy();
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      {
        path: '/api/v1/catalog/products/bulk',
        body: {
          ids: [SOUP.id, WATER.id],
          action: { kind: 'price', change: { mode: 'percent', value: '10' } },
        },
      },
    ]);
  });

  it('names the products a delete kept and archives them on request', async () => {
    signedInAs('owner');
    const writes = api({
      '/api/v1/catalog/products/bulk': {
        updated: [],
        deleted: [WATER.id],
        kept: [{ id: SOUP.id, reason: 'sold' }],
      },
    });
    render(<CatalogPage />);
    await pick('Select Soup');
    await pick('Select Water');
    await userEvent.click(screen.getByTestId('bulk-delete'));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    const kept = await screen.findByTestId('bulk-kept');
    expect(kept.textContent).toContain('Soup');
    expect(writes[0]?.body).toEqual({ ids: [SOUP.id, WATER.id], action: { kind: 'delete' } });

    await userEvent.click(screen.getByTestId('bulk-kept-archive'));
    await waitFor(() => expect(screen.queryByTestId('bulk-kept')).toBeNull());
    expect(writes[1]).toEqual({
      path: '/api/v1/catalog/products/bulk',
      body: { ids: [SOUP.id], action: { kind: 'archive' } },
    });
  });

  it('deletes selected categories, saying products go with them', async () => {
    signedInAs('owner');
    const writes = api();
    render(<CatalogPage />);
    await pick('Select Food');
    await userEvent.click(screen.getByTestId('bulk-category-delete'));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/products are deleted with them/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: '/api/v1/catalog/categories/bulk',
      body: { ids: [FOOD.id], action: 'delete' },
    });
  });
});
