// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { CategoryDialog } from '../catalog/category-dialog';
import { BrandProvider } from '../theme-provider';
import { InventoryPage } from './inventory-page';

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

const id = (n: number) => `0190a000-0000-7000-8000-0000000049${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(1), name: 'Main street', brandId: id(90) };
const WAREHOUSE = {
  id: id(2),
  locationId: LOCATION.id,
  name: 'Main Warehouse',
  sortOrder: 0,
  suppliesStation: null,
  isTransit: false,
  archivedAt: null,
};
const category = (n: number, name: string, parentId: string | null = null) => ({
  id: id(10 + n),
  name,
  sortOrder: n * 10,
  station: 'kitchen' as const,
  description: null,
  parentId,
  imageVersion: null,
  archivedAt: null,
});
const FOOD = category(1, 'African Item');
const RICE = category(2, 'Rice', FOOD.id);
const DRINKS = category(3, 'Beverages');
const item = (n: number, name: string, categoryId: string | null) => ({
  id: id(30 + n),
  name,
  sku: null,
  unit: 'pc',
  minQuantity: null,
  parentItemId: null,
  variantValues: [],
  salePrice: null,
  categoryId,
  archivedAt: null,
});
const YAM = item(1, 'Yam flour', FOOD.id);
const BASMATI = item(2, 'Basmati rice', RICE.id);
const COLA = item(3, 'Cola', DRINKS.id);
const LOOSE = item(4, 'Loose item', null);
const level = (itemId: string, quantity: string, value: string | null, low = false) => ({
  warehouseId: WAREHOUSE.id,
  itemId,
  itemName: '',
  unit: 'pc',
  quantity,
  // Without inventory.prices.read the api sends no costs or values (ADR 0060).
  averageCost: value === null ? null : '1.0000',
  value,
  low,
});

function signedIn(
  features = ['inventory', 'catalog', 'orders'],
  role: 'owner' | 'branch' = 'owner',
) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: features,
  });
}

function api() {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const answers: Record<string, unknown> = {
    'GET /api/v1/locations': { data: [LOCATION] },
    'GET /api/v1/inventory/warehouses': { data: [WAREHOUSE] },
    'GET /api/v1/inventory/items': { data: [YAM, BASMATI, COLA, LOOSE] },
    'GET /api/v1/inventory/units': { data: [] },
    'GET /api/v1/catalog/categories': { data: [FOOD, RICE, DRINKS] },
    // The same categories for stock readers without the catalog (ADR 0059).
    'GET /api/v1/inventory/categories': { data: [FOOD, RICE, DRINKS] },
    'GET /api/v1/inventory/stock': {
      data: [level(YAM.id, '4.000', '8.00', true), level(BASMATI.id, '10.000', '20.00')],
    },
    'GET /api/v1/settings': {
      data: [
        { key: 'locale', value: 'en', source: 'default', dataBound: false },
        { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
      ],
    },
  };
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve(Response.json({ ...FOOD, id: id(99) }, { status: 201 }));
    }
    return Promise.resolve(Response.json(answers[`${method} ${path}`] ?? { data: [] }));
  });
  return writes;
}

const operations = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'AsiaMight', logoUrl: null, navLayout: 'operations' }}>
    {children}
  </BrandProvider>
);

describe('AsiaMight inventory overview (ADR 0048)', () => {
  it('opens on category tiles with their item counts, and a tile lists its items', async () => {
    signedIn();
    api();
    render(<InventoryPage />, { wrapper: operations });
    const tiles = await screen.findAllByTestId('category-tile');
    expect(tiles.map((tile) => tile.getAttribute('data-name'))).toEqual([
      'All items',
      'African Item',
      'Beverages',
      'Uncategorized',
    ]);
    // A secondary category's items count for its parent.
    expect(within(tiles[1]!).getByTestId('category-tile-count').textContent).toBe('2 items');
    // No tab bar here: the other pages are in More.
    expect(screen.queryByTestId('inventory-tab-receive')).toBeNull();

    await userEvent.click(tiles[1]!);
    const rows = await screen.findAllByTestId('overview-row');
    expect(rows.map((r) => r.getAttribute('data-name'))).toEqual(['Yam flour', 'Basmati rice']);
    expect(screen.getByTestId('overview-low')).toBeTruthy();
    // Its secondary category as a chip narrows the list.
    await userEvent.click(screen.getByTestId('overview-chip'));
    expect(screen.getAllByTestId('overview-row').map((r) => r.getAttribute('data-name'))).toEqual([
      'Basmati rice',
    ]);
    await userEvent.click(screen.getByTestId('overview-back'));
    expect(await screen.findAllByTestId('category-tile')).toHaveLength(4);
  });

  it('filters by stock level and finds products from the search box', async () => {
    signedIn();
    api();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await userEvent.selectOptions(screen.getByTestId('overview-stock'), 'low');
    expect(
      within(screen.getAllByTestId('category-tile')[0]!).getByTestId('category-tile-count')
        .textContent,
    ).toBe('1 items');
    await userEvent.selectOptions(screen.getByTestId('overview-stock'), 'all');
    await userEvent.type(screen.getByTestId('overview-search'), 'cola');
    const found = await screen.findByTestId('overview-found');
    expect(within(found).getAllByTestId('overview-row')).toHaveLength(1);
  });

  it('exports what is listed as CSV', async () => {
    signedIn();
    api();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await userEvent.click(screen.getByTestId('overview-export'));
    expect(click).toHaveBeenCalled();
    const text = await blobs[0]!.text();
    expect(text).toContain('Basmati rice,,African Item › Rice,');
    expect(text.split('\r\n')).toHaveLength(6);
    click.mockRestore();
  });

  it('keeps the other pages in More, with a way back', async () => {
    signedIn();
    api();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await userEvent.click(screen.getByTestId('inventory-more'));
    expect(await screen.findByTestId('inventory-more-receive')).toBeTruthy();
    expect(screen.getByTestId('inventory-more-inventory-units')).toBeTruthy();
    await userEvent.click(screen.getByTestId('inventory-more-items'));
    expect(await screen.findByTestId('inventory-back')).toBeTruthy();
    await userEvent.click(screen.getByTestId('inventory-back'));
    expect(await screen.findAllByTestId('category-tile')).toHaveLength(4);
  });

  it('files a new item under a category', async () => {
    signedIn();
    const writes = api();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await userEvent.click(screen.getByTestId('item-create'));
    await userEvent.type(await screen.findByLabelText('Name'), 'Plantain chips');
    await userEvent.selectOptions(screen.getByTestId('item-category'), RICE.id);
    expect(screen.getByTestId('item-category').textContent).toContain('African Item › Rice');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes.find((w) => w.path === '/api/v1/inventory/items')?.body).toMatchObject({
        name: 'Plantain chips',
        categoryId: RICE.id,
      }),
    );
  });

  it('keeps the tabbed page in the default menu', async () => {
    signedIn();
    api();
    render(<InventoryPage />);
    expect(await screen.findByTestId('inventory-tab-receive')).toBeTruthy();
    expect(screen.queryByTestId('category-tile')).toBeNull();
  });
});

describe('category dialog (ADR 0048)', () => {
  it('asks for description, secondary category and image; no kitchen/bar without the till', async () => {
    signedIn();
    const writes = api();
    render(<CategoryDialog categories={[FOOD, RICE, DRINKS]} onDone={() => undefined} />);
    await userEvent.click(screen.getByTestId('category-create'));
    expect(screen.queryByTestId('category-station-select')).toBeNull();
    expect(screen.getByTestId('category-image-pick')).toBeTruthy();
    // Only top-level categories can be a parent.
    const parents = within(screen.getByTestId('category-parent'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(parents).toEqual(['None (top level)', 'African Item', 'Beverages']);
    await userEvent.type(screen.getByTestId('category-name'), 'Yams');
    await userEvent.type(screen.getByTestId('category-description'), 'Roots and tubers');
    await userEvent.selectOptions(screen.getByTestId('category-parent'), FOOD.id);
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        method: 'POST',
        path: '/api/v1/catalog/categories',
        body: { name: 'Yams', description: 'Roots and tubers', parentId: FOOD.id },
      }),
    );
    expect(writes[0]!.body).not.toHaveProperty('station');
  });

  it('shows where items print to organizations with the till, and locks a parent with secondary ones', async () => {
    signedIn(['inventory', 'catalog', 'pos']);
    api();
    render(
      <CategoryDialog category={FOOD} categories={[FOOD, RICE, DRINKS]} onDone={() => undefined} />,
    );
    await userEvent.click(screen.getByTestId('category-edit'));
    expect(screen.getByTestId('category-station-select')).toBeTruthy();
    expect(screen.getByTestId('category-parent')).toHaveProperty('disabled', true);
  });

  it('offers the request cart to branches, not to who approves requests', async () => {
    signedIn(['inventory', 'catalog', 'orders'], 'branch');
    api();
    render(<InventoryPage />, { wrapper: operations });
    const request = await screen.findByTestId('inventory-request-stock');
    expect(request.getAttribute('href')).toBe('/requests/new');
    expect(request.textContent).toBe('Request cart');
    cleanup();

    signedIn();
    api();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    expect(screen.queryByTestId('inventory-request-stock')).toBeNull();
    cleanup();

    // Without orders there are no requests.
    signedIn(['inventory', 'catalog'], 'branch');
    api();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    expect(screen.queryByTestId('inventory-request-stock')).toBeNull();
  });

  it('shows a branch its stock by category without the catalog, with the request cart (ADR 0059)', async () => {
    signedIn(['inventory', 'catalog', 'orders'], 'branch');
    api();
    render(<InventoryPage />, { wrapper: operations });
    const tiles = await screen.findAllByTestId('category-tile');
    expect(tiles.map((tile) => tile.getAttribute('data-name'))).toEqual([
      'All items',
      'African Item',
      'Beverages',
      'Uncategorized',
    ]);
    expect(within(tiles[1]!).getByTestId('category-tile-count').textContent).toBe('2 items');
    // Read from inventory: the catalog (and its prices) stays closed to a branch.
    const paths = mockState.store.apiFetch.mock.calls.map(([input]) => String(input));
    expect(paths.some((p) => p.startsWith('/api/v1/inventory/categories'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/api/v1/catalog/'))).toBe(false);
    expect(screen.getByTestId('inventory-request-stock').textContent).toBe('Request cart');
  });

  it('shows a branch quantities only: no value column, total or export value (ADR 0060)', async () => {
    signedIn(['inventory', 'catalog', 'orders'], 'branch');
    api();
    mockState.store.apiFetch.mockImplementation((input: string) => {
      const path = input.replace(/\?.*$/, '');
      const answers: Record<string, unknown> = {
        '/api/v1/inventory/warehouses': { data: [WAREHOUSE] },
        '/api/v1/inventory/items': { data: [YAM, BASMATI, COLA, LOOSE] },
        '/api/v1/inventory/categories': { data: [FOOD, RICE, DRINKS] },
        '/api/v1/inventory/stock': {
          data: [level(YAM.id, '4.000', null, true), level(BASMATI.id, '10.000', null)],
        },
      };
      return Promise.resolve(Response.json(answers[path] ?? { data: [] }));
    });
    render(<InventoryPage />, { wrapper: operations });
    expect(
      await screen.findByText('Live stock by category, warehouse and stock level.'),
    ).toBeTruthy();
    const tiles = await screen.findAllByTestId('category-tile');
    await userEvent.click(tiles[1]!);
    const rows = await screen.findAllByTestId('overview-row');
    expect(rows.map((r) => r.getAttribute('data-name'))).toEqual(['Yam flour', 'Basmati rice']);
    expect(within(rows[0]!).getByTestId('overview-quantity').textContent).toBe('4 pc');
    expect(screen.queryByTestId('overview-total')).toBeNull();
    expect(screen.queryByText('Value')).toBeNull();
  });
});
