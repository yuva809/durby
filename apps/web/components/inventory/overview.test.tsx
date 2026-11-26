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

  /** Captures downloads: the file name and its blob. */
  function downloads() {
    const files: { name: string; blob: Blob }[] = [];
    let pending: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      pending = blob;
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      files.push({ name: this.download, blob: pending! });
    });
    return { files, restore: () => click.mockRestore() };
  }

  async function exportAs(format: 'xlsx' | 'csv' | 'pdf') {
    await userEvent.click(screen.getByTestId('overview-export'));
    await userEvent.click(await screen.findByTestId(`overview-export-${format}`));
  }

  it('exports what is listed as CSV', async () => {
    signedIn();
    api();
    const { files, restore } = downloads();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await exportAs('csv');
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toMatch(/^inventory-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await files[0]!.blob.text();
    expect(text).toContain('Basmati rice,,African Item › Rice,');
    expect(text.split('\r\n')).toHaveLength(6);
    restore();
  });

  it('exports what is listed as Excel and as PDF', async () => {
    signedIn();
    api();
    const { files, restore } = downloads();
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await exportAs('xlsx');
    await waitFor(() => expect(files).toHaveLength(1));
    expect(files[0]!.name).toMatch(/^inventory-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const { default: readXlsxFile } = await import('read-excel-file/universal');
    const [sheet] = await readXlsxFile(await files[0]!.blob.arrayBuffer());
    expect(sheet!.sheet).toBe('Inventory');
    expect(sheet!.data[0]![0]).toBe('Item');
    expect(sheet!.data.map((r) => r[0])).toContain('Basmati rice');

    await exportAs('pdf');
    await waitFor(() => expect(files).toHaveLength(2));
    expect(files[1]!.name).toMatch(/\.pdf$/);
    const pdf = new TextDecoder('latin1').decode(await files[1]!.blob.arrayBuffer());
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf).toContain('Basmati rice');
    expect(pdf).toContain('Demo Bistro');
    expect(pdf).toContain('Stock level: All stock');
    expect(pdf).toContain('Page 1 of 1');
    restore();
  });

  it('says so when a file cannot be made', async () => {
    signedIn();
    api();
    const { files, restore } = downloads();
    // The browser refuses the file.
    URL.createObjectURL = vi.fn(() => {
      throw new Error('no file');
    });
    render(<InventoryPage />, { wrapper: operations });
    await screen.findAllByTestId('category-tile');
    await exportAs('xlsx');
    expect(
      await screen.findByText('The file could not be made. Check the connection and try again.'),
    ).toBeTruthy();
    expect(files).toEqual([]);
    restore();
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

  it("adjusts a product's stock from its row: the count there now, the difference booked", async () => {
    signedIn();
    const writes = api();
    render(<InventoryPage />, { wrapper: operations });
    const tiles = await screen.findAllByTestId('category-tile');
    await userEvent.click(tiles[1]!);
    const rows = await screen.findAllByTestId('overview-row');
    const yam = rows.find((r) => r.dataset.name === 'Yam flour')!;
    // Owners may adjust and edit.
    expect(within(yam).getByTestId('item-edit')).toBeTruthy();
    await userEvent.click(within(yam).getByTestId('item-adjust'));
    const dialog = await screen.findByRole('dialog');
    // Only the stock: no item fields.
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    const quantity = within(dialog).getByTestId<HTMLInputElement>('item-add-quantity');
    await waitFor(() => expect(quantity.value).toBe('4'));
    // Nothing changed: said, nothing sent.
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(
      within(dialog).getByText('Type the counted quantity; it is the same as on hand now.'),
    ).toBeTruthy();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '6');
    await userEvent.selectOptions(within(dialog).getByTestId('item-add-reason'), 'count');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/adjustments',
      body: {
        warehouseId: WAREHOUSE.id,
        reason: 'count',
        lines: [{ itemId: YAM.id, quantity: '2' }],
      },
    });
  });

  it('offers the request cart to branches, not to who approves requests', async () => {
    signedIn(['inventory', 'catalog', 'orders'], 'branch');
    api();
    render(<InventoryPage />, { wrapper: operations });
    const request = await screen.findByTestId('inventory-request-stock');
    // The cart opens here, in a sheet, not on another page.
    expect(request.tagName).toBe('BUTTON');
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
    expect(screen.queryByText('Value')).toBeNull();
  });

  it('lists a category as a branch shops it: brand, pack, main stock, best before, by the box (ADR 0065)', async () => {
    localStorage.clear();
    signedIn(['inventory', 'catalog', 'orders'], 'branch');
    const offer = (item: typeof YAM, available: string, extra: Record<string, unknown> = {}) => ({
      itemId: item.id,
      itemName: item.name,
      sku: null,
      unit: 'pc',
      available,
      categoryId: item.categoryId,
      categoryName: null,
      expiresOn: null,
      brand: null,
      packCount: null,
      packSize: null,
      packUnit: null,
      ...extra,
    });
    mockState.store.apiFetch.mockImplementation((input: string) => {
      const path = input.replace(/\?.*$/, '');
      const answers: Record<string, unknown> = {
        '/api/v1/inventory/warehouses': { data: [WAREHOUSE] },
        '/api/v1/inventory/items': { data: [YAM, BASMATI, COLA, LOOSE] },
        '/api/v1/inventory/categories': { data: [FOOD, RICE, DRINKS] },
        '/api/v1/inventory/stock': { data: [] },
        '/api/v1/stock-requests/warehouses': {
          data: [
            {
              id: WAREHOUSE.id,
              name: 'Main',
              locationId: LOCATION.id,
              locationName: 'Main street',
              canRequestInto: false,
              isMain: true,
            },
          ],
        },
        '/api/v1/stock-requests/destinations': {
          data: [
            { locationId: id(70), locationName: 'Spandau', warehouseId: null, warehouseName: null },
          ],
        },
        [`/api/v1/stock-requests/availability/${WAREHOUSE.id}`]: {
          data: [
            offer(YAM, '30.000', {
              brand: 'Golden Morn',
              packCount: 12,
              packSize: '300.000',
              packUnit: 'g',
              expiresOn: '2999-03-31',
            }),
            offer(BASMATI, '5.000'),
            offer(COLA, '9.000'),
          ],
        },
      };
      return Promise.resolve(Response.json(answers[path] ?? { data: [] }));
    });
    render(<InventoryPage />, { wrapper: operations });
    const tiles = await screen.findAllByTestId('category-tile');
    await userEvent.click(tiles[1]!);
    const rows = await screen.findAllByTestId('branch-shop-row');
    // The category's items only, with what the main warehouse has.
    expect(rows.map((r) => r.getAttribute('data-name'))).toEqual(['Yam flour', 'Basmati rice']);
    expect(rows[0]!.textContent).toContain('Golden Morn');
    expect(within(rows[0]!).getByTestId('branch-shop-pack').textContent).toBe('12 × 300 g');
    expect(within(rows[0]!).getByTestId('branch-shop-available').textContent).toBe('30');

    // "Request" puts one box (12 a box) in the cart; the header's Request Cart counts it at once.
    expect(screen.queryByTestId('request-cart-badge')).toBeNull();
    await userEvent.click(within(rows[0]!).getByTestId('request-add'));
    expect(screen.getByTestId('request-cart-badge').textContent).toBe('1');
    // At one box the button takes it out (a bin); above it, one less.
    expect(within(rows[0]!).getByTestId('request-less').getAttribute('aria-label')).toBe(
      'Remove Yam flour',
    );
    await userEvent.click(within(rows[0]!).getByTestId('request-more'));
    expect(within(rows[0]!).getByTestId<HTMLInputElement>('request-quantity').value).toBe('2');
    expect(within(rows[0]!).getByTestId('request-pieces').textContent).toBe('= 24 pc');
    // More than the 30 there may still be asked for: it follows once it is in.
    expect(within(rows[0]!).getByTestId('request-more')).toHaveProperty('disabled', false);
    // By the piece the same 24, one at a time.
    await userEvent.selectOptions(within(rows[0]!).getByTestId('request-unit'), 'piece');
    expect(within(rows[0]!).getByTestId<HTMLInputElement>('request-quantity').value).toBe('24');
    await userEvent.click(within(rows[0]!).getByTestId('request-more'));
    await userEvent.click(within(rows[1]!).getByTestId('request-add'));
    expect(screen.getByTestId('request-cart-badge').textContent).toBe('2');
    const stored = Object.entries(localStorage).find(([k]) => k.startsWith('request-cart:'));
    expect(JSON.parse(stored![1] as string)).toEqual({ [YAM.id]: '25', [BASMATI.id]: '1' });

    // The cart opens beside the page, not on another one.
    await userEvent.click(screen.getByTestId('inventory-request-stock'));
    const cart = await screen.findByTestId('request-cart');
    expect(within(cart).getAllByTestId('request-cart-line')).toHaveLength(2);
    expect(
      within(cart)
        .getAllByTestId('request-cart-available')
        .map((a) => a.textContent),
    ).toEqual(['30 pc available at the warehouse', '5 pc available at the warehouse']);
    expect(within(cart).getByTestId('request-cart-count').textContent).toBe('2 items');
    expect(within(cart).getByTestId('request-cart-units').textContent).toBe('26 units');
    expect(within(cart).getByTestId('request-cart-history').getAttribute('href')).toBe('/requests');
    await userEvent.click(within(cart).getByTestId('request-clear'));
    expect(within(cart).getByTestId('request-cart-empty')).toBeTruthy();
    expect(screen.queryByTestId('request-cart-badge')).toBeNull();
  });
});
