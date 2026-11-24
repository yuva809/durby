// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { InventoryPage } from './inventory-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000010${String(n).padStart(2, '0')}`;
const MAIN_LOCATION = { id: id(1), name: 'Main street', brandId: id(90) };
const warehouse = (n: number, name: string, suppliesStation: string | null = null) => ({
  id: id(10 + n),
  locationId: MAIN_LOCATION.id,
  name,
  sortOrder: 0,
  suppliesStation,
  suppliesLocationIds: [] as string[],
  archivedAt: null,
});
const STORE = warehouse(1, 'Main store', 'kitchen');
const BAR = warehouse(2, 'Bar', 'bar');
const item = (n: number, name: string, unit: string, minQuantity: string | null = null) => ({
  id: id(20 + n),
  name,
  sku: null,
  unit,
  minQuantity,
  archivedAt: null,
});
const TOMATOES = item(1, 'Tomatoes', 'kg', '5.000');
const COLA = item(2, 'Cola 0.33', 'pc');

const document = (number: string, kind: string, value: string) => ({
  id: id(40),
  number,
  kind,
  warehouseId: STORE.id,
  warehouseName: STORE.name,
  toWarehouseId: null,
  toWarehouseName: null,
  reason: null,
  supplier: null,
  note: null,
  lineCount: 1,
  value,
  createdAt: '2026-11-04T10:00:00.000Z',
  lines: [],
});

function signedInAs(role: SystemRole, features = ['inventory', 'pos']) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: features,
  });
}

function api(extra: Record<string, () => Response> = {}) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    }
    const answers: Record<string, () => Response> = {
      'GET /api/v1/settings': () =>
        Response.json({
          data: [
            { key: 'locale', value: 'en', source: 'default', dataBound: false },
            { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
          ],
        }),
      'GET /api/v1/locations': () => Response.json({ data: [MAIN_LOCATION] }),
      'GET /api/v1/inventory/warehouses': () => Response.json({ data: [STORE, BAR] }),
      'GET /api/v1/inventory/items': () => Response.json({ data: [TOMATOES, COLA] }),
      'GET /api/v1/inventory/stock': () =>
        Response.json({
          data: [
            {
              warehouseId: STORE.id,
              itemId: COLA.id,
              itemName: 'Cola 0.33',
              unit: 'pc',
              quantity: '24.000',
              averageCost: '0.4500',
              value: '10.80',
              low: false,
              expiresOn: '2999-12-31',
            },
            {
              warehouseId: STORE.id,
              itemId: TOMATOES.id,
              itemName: 'Tomatoes',
              unit: 'kg',
              quantity: '4.500',
              averageCost: '3.0000',
              value: '13.50',
              low: true,
              expiresOn: '2020-01-15',
            },
          ],
        }),
      ...extra,
    };
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
  return writes;
}

const tab = (name: string) => screen.findByTestId(`inventory-tab-${name}`);

describe('InventoryPage', () => {
  it('needs the inventory feature and inventory.stock.read', () => {
    signedInAs('owner', ['pos']);
    api();
    render(<InventoryPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    cleanup();
    signedInAs('waiter');
    render(<InventoryPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('shows stock with quantities, value, a total and low items; filters low only', async () => {
    signedInAs('manager');
    api();
    render(<InventoryPage />);
    const rows = await screen.findAllByTestId('stock-row');
    expect(rows.map((r) => r.dataset.name)).toEqual(['Cola 0.33', 'Tomatoes']);
    expect(within(rows[1]!).getByTestId('stock-quantity').textContent).toBe('4.5 kg');
    expect(within(rows[1]!).getByTestId('stock-low')).toBeTruthy();
    // Best before (ADR 0062): the earliest date of what is there, red when past.
    expect(within(rows[0]!).getByTestId('stock-expiry').textContent).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date('2999-12-31T00:00:00Z'),
      ),
    );
    expect(within(rows[1]!).getByTestId('stock-expiry').dataset.expired).toBe('true');
    expect(screen.getByTestId('stock-total').textContent).toBe('Stock value: €24.30');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Low stock only' }));
    expect(screen.getAllByTestId('stock-row').map((r) => r.dataset.name)).toEqual(['Tomatoes']);
  });

  it('shows Staff only the reading tabs', async () => {
    signedInAs('staff');
    api();
    render(<InventoryPage />);
    await tab('stock');
    expect(screen.queryByTestId('inventory-tab-receive')).toBeNull();
    expect(screen.queryByTestId('inventory-tab-transfer')).toBeNull();
    expect(screen.getByTestId('inventory-tab-documents')).toBeTruthy();
  });

  it('receives a delivery with a live total and books it', async () => {
    signedInAs('manager');
    const writes = api({
      'POST /api/v1/inventory/receipts': () =>
        Response.json(document('GR-2026-000001', 'receipt', '35.80'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('receive'));
    await userEvent.type(screen.getByTestId('doc-supplier'), 'Metro');
    await userEvent.selectOptions(screen.getAllByTestId('doc-item')[0]!, TOMATOES.id);
    await userEvent.type(screen.getAllByTestId('doc-quantity')[0]!, '10');
    await userEvent.type(screen.getAllByTestId('doc-cost')[0]!, '2,5');
    fireEvent.change(screen.getAllByTestId('doc-expiry')[0]!, { target: { value: '2027-03-31' } });
    await userEvent.click(screen.getByTestId('doc-add-line'));
    await userEvent.selectOptions(screen.getAllByTestId('doc-item')[1]!, COLA.id);
    await userEvent.type(screen.getAllByTestId('doc-quantity')[1]!, '24');
    await userEvent.type(screen.getAllByTestId('doc-cost')[1]!, '0.45');
    expect(screen.getByTestId('doc-total').textContent).toBe('Total: €35.80');
    await userEvent.click(screen.getByTestId('doc-post'));
    expect(await screen.findByText('Booked as GR-2026-000001.')).toBeTruthy();
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/inventory/receipts',
        body: {
          warehouseId: STORE.id,
          supplier: 'Metro',
          lines: [
            { itemId: TOMATOES.id, quantity: '10', unitCost: '2.5', expiresOn: '2027-03-31' },
            { itemId: COLA.id, quantity: '24', unitCost: '0.45' },
          ],
        },
      },
    ]);
    // The form starts over.
    expect((screen.getAllByTestId('doc-quantity')[0] as HTMLInputElement).value).toBe('');
  });

  it('marks bad lines instead of sending them', async () => {
    signedInAs('manager');
    const writes = api();
    render(<InventoryPage />);
    await userEvent.click(await tab('receive'));
    await userEvent.selectOptions(screen.getAllByTestId('doc-item')[0]!, TOMATOES.id);
    await userEvent.type(screen.getAllByTestId('doc-quantity')[0]!, '1.2345');
    await userEvent.type(screen.getAllByTestId('doc-cost')[0]!, '1');
    await userEvent.click(screen.getByTestId('doc-post'));
    expect(await screen.findByText('Check the highlighted lines.')).toBeTruthy();
    expect(screen.getAllByTestId('doc-quantity')[0]!.getAttribute('aria-invalid')).toBe('true');
    expect(writes).toEqual([]);
  });

  it('books waste as a negative adjustment with its reason', async () => {
    signedInAs('kitchen');
    const writes = api({
      'POST /api/v1/inventory/adjustments': () =>
        Response.json(document('ADJ-2026-000001', 'adjustment', '-4.50'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('adjust'));
    await userEvent.selectOptions(screen.getByTestId('doc-reason'), 'waste');
    await userEvent.selectOptions(screen.getAllByTestId('doc-item')[0]!, TOMATOES.id);
    await userEvent.type(screen.getAllByTestId('doc-quantity')[0]!, '-1.5');
    await userEvent.click(screen.getByTestId('doc-post'));
    await screen.findByText('Booked as ADJ-2026-000001.');
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/adjustments',
      body: {
        warehouseId: STORE.id,
        reason: 'waste',
        lines: [{ itemId: TOMATOES.id, quantity: '-1.5' }],
      },
    });
  });

  it('transfers between two warehouses, not into the same one', async () => {
    signedInAs('manager');
    const writes = api({
      'POST /api/v1/inventory/transfers': () =>
        Response.json(document('TRF-2026-000001', 'transfer', '-6.00'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('transfer'));
    await userEvent.selectOptions(screen.getAllByTestId('doc-item')[0]!, COLA.id);
    await userEvent.type(screen.getAllByTestId('doc-quantity')[0]!, '12');
    await userEvent.selectOptions(screen.getByTestId('doc-to'), STORE.id);
    await userEvent.click(screen.getByTestId('doc-post'));
    expect(await screen.findByText('Choose two different warehouses.')).toBeTruthy();
    await userEvent.selectOptions(screen.getByTestId('doc-to'), BAR.id);
    await userEvent.click(screen.getByTestId('doc-post'));
    await screen.findByText('Booked as TRF-2026-000001.');
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/inventory/transfers',
        body: {
          fromWarehouseId: STORE.id,
          toWarehouseId: BAR.id,
          lines: [{ itemId: COLA.id, quantity: '12' }],
        },
      },
    ]);
  });

  it('adds a stock item with its unit and reorder level (admins)', async () => {
    signedInAs('admin');
    const writes = api({
      'POST /api/v1/inventory/items': () =>
        Response.json(item(3, 'Flour', 'kg', '10.000'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    expect(screen.getAllByTestId('item-row').map((r) => r.dataset.name)).toEqual([
      'Tomatoes',
      'Cola 0.33',
    ]);
    await userEvent.click(screen.getByTestId('item-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Flour');
    await userEvent.type(within(dialog).getByLabelText('Reorder level'), '10');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/items',
      body: { name: 'Flour', unit: 'kg', minQuantity: '10' },
    });
  });

  it('sets the stock quantity while editing an item: more received at a cost, less adjusted out', async () => {
    signedInAs('admin');
    const writes = api({
      [`PATCH /api/v1/inventory/items/${COLA.id}`]: () => Response.json(COLA),
      'POST /api/v1/inventory/receipts': () =>
        Response.json(document('GR-2026-000002', 'receipt', '6.00'), { status: 201 }),
      'POST /api/v1/inventory/adjustments': () =>
        Response.json(document('ADJ-2026-000002', 'adjustment', '-0.90'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    const cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    await waitFor(() => expect(within(cola).getAllByTestId('item-warehouse-row')).toHaveLength(1));
    await userEvent.click(within(cola).getByTestId('item-edit'));
    let dialog = await screen.findByRole('dialog');
    // What is there now, to change; nothing is booked while it stays.
    const quantity = within(dialog).getByTestId<HTMLInputElement>('item-add-quantity');
    expect(quantity.value).toBe('24');
    expect(within(dialog).getByTestId('item-add-on-hand').textContent).toBe(
      'Currently 24 pc on hand in Main store. Changing it books the difference there.',
    );
    expect(within(dialog).queryByTestId('item-add-reason')).toBeNull();
    // 36: 12 more, received at a cost (the cost of one unit is needed).
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '36');
    expect(within(dialog).getByTestId('item-add-on-hand').textContent).toBe(
      'Adds 12 pc to the 24 on hand.',
    );
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter the cost of one unit, e.g. 2.50.')).toBeTruthy();
    expect(writes).toEqual([]);
    await userEvent.type(within(dialog).getByTestId('item-add-cost'), '0,50');
    await userEvent.type(within(dialog).getByTestId('item-add-remarks'), 'Cash and carry');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[1]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/receipts',
      body: {
        warehouseId: STORE.id,
        note: 'Cash and carry',
        lines: [{ itemId: COLA.id, quantity: '12', unitCost: '0.50' }],
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 22: 2 out, as an adjustment with its reason, no cost asked.
    await userEvent.click(within(cola).getByTestId('item-edit'));
    dialog = await screen.findByRole('dialog');
    const again = within(dialog).getByTestId<HTMLInputElement>('item-add-quantity');
    await userEvent.clear(again);
    await userEvent.type(again, '22');
    expect(
      [...within(dialog).getByTestId<HTMLSelectElement>('item-add-reason').options].map(
        (o) => o.value,
      ),
    ).toEqual(['correction', 'count', 'waste', 'breakage', 'other']);
    await userEvent.selectOptions(within(dialog).getByTestId('item-add-reason'), 'breakage');
    expect(within(dialog).queryByTestId('item-add-cost')).toBeNull();
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(4));
    expect(writes[3]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/adjustments',
      body: {
        warehouseId: STORE.id,
        reason: 'breakage',
        lines: [{ itemId: COLA.id, quantity: '-2' }],
      },
    });
  });

  it('relabels a stocked item from Stück to box and sets the count in one save; weight is not offered', async () => {
    signedInAs('admin');
    const writes = api({
      [`PATCH /api/v1/inventory/items/${COLA.id}`]: () => Response.json({ ...COLA, unit: 'box' }),
      'POST /api/v1/inventory/adjustments': () =>
        Response.json(document('ADJ-2026-000003', 'adjustment', '-5.40'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    const cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    await waitFor(() => expect(within(cola).getAllByTestId('item-warehouse-row')).toHaveLength(1));
    await userEvent.click(within(cola).getByTestId('item-edit'));
    const dialog = await screen.findByRole('dialog');
    const unit = within(dialog).getByTestId<HTMLSelectElement>('item-unit');
    expect([...unit.options].map((o) => o.value)).toEqual(['pc', 'box', 'bucket', 'bag', 'packet']);
    await userEvent.selectOptions(unit, 'box');
    expect(within(dialog).getByTestId('item-unit-relabel').textContent).toContain(
      '24 pc become 24 box',
    );
    const quantity = within(dialog).getByTestId<HTMLInputElement>('item-add-quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '12');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toMatchObject({ method: 'PATCH', body: { unit: 'box' } });
    expect(writes[1]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/adjustments',
      body: {
        warehouseId: STORE.id,
        reason: 'correction',
        lines: [{ itemId: COLA.id, quantity: '-12' }],
      },
    });
  });

  it('sets the stock quantity to 0: everything there is booked out, no decimals error', async () => {
    signedInAs('admin');
    const writes = api({
      [`PATCH /api/v1/inventory/items/${COLA.id}`]: () => Response.json(COLA),
      'POST /api/v1/inventory/adjustments': () =>
        Response.json(document('ADJ-2026-000004', 'adjustment', '-10.80'), { status: 201 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    const cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    await waitFor(() => expect(within(cola).getAllByTestId('item-warehouse-row')).toHaveLength(1));
    await userEvent.click(within(cola).getByTestId('item-edit'));
    const dialog = await screen.findByRole('dialog');
    const quantity = within(dialog).getByTestId<HTMLInputElement>('item-add-quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '0');
    expect(within(dialog).getByTestId('item-add-on-hand').textContent).toBe(
      'Takes 24 pc out of the 24 on hand.',
    );
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).queryByText('Enter a quantity with up to 3 decimals.')).toBeNull();
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      method: 'POST',
      path: '/api/v1/inventory/adjustments',
      body: {
        warehouseId: STORE.id,
        reason: 'correction',
        lines: [{ itemId: COLA.id, quantity: '-24' }],
      },
    });
  });

  it('sets the brand and pack size (pieces × weight) when adding and editing an item', async () => {
    signedInAs('admin');
    const writes = api({
      'POST /api/v1/inventory/items': () =>
        Response.json({ ...item(3, 'Kingmackerel', 'box'), brand: 'Perfit' }, { status: 201 }),
      [`PATCH /api/v1/inventory/items/${COLA.id}`]: () => Response.json(COLA),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    await userEvent.click(screen.getByTestId('item-create'));
    let dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Kingmackerel');
    await userEvent.type(within(dialog).getByTestId('item-brand'), 'Perfit');
    await userEvent.type(within(dialog).getByTestId('item-pack-count'), '8');
    await userEvent.type(within(dialog).getByTestId('item-pack-size'), '1');
    // A weight without its unit: said, nothing sent.
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(
      within(dialog).getByText('Pieces: a whole number; weight: a number with its unit.'),
    ).toBeTruthy();
    expect(writes).toEqual([]);
    await userEvent.selectOptions(within(dialog).getByTestId('item-pack-unit'), 'kg');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toEqual({
      name: 'Kingmackerel',
      unit: 'kg',
      brand: 'Perfit',
      packCount: 8,
      packSize: '1',
      packUnit: 'kg',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Editing: pieces only; brand and weight cleared are sent as null.
    const cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    await userEvent.click(within(cola).getByTestId('item-edit'));
    dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('item-pack-count'), '24');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toMatchObject({
      brand: null,
      packCount: 24,
      packSize: null,
      packUnit: null,
    });
  });

  it('offers Archive instead when an item with stock history cannot be deleted', async () => {
    signedInAs('owner');
    const writes = api({
      [`DELETE /api/v1/inventory/items/${COLA.id}`]: () =>
        Response.json({ code: 'inventory.item_in_use', message: 'in use' }, { status: 409 }),
      [`PATCH /api/v1/inventory/items/${COLA.id}`]: () =>
        Response.json({ ...COLA, archivedAt: '2026-11-24T10:00:00.000Z' }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    const cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    await userEvent.click(within(cola).getByTestId('item-delete'));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await userEvent.click(await within(dialog).findByTestId('item-delete-fallback'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/inventory/items/${COLA.id}`,
      body: { archived: true },
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('lets owners delete an item with all its history; others only archive it (ADR 0079)', async () => {
    signedInAs('owner');
    const writes = api({
      [`DELETE /api/v1/inventory/items/${COLA.id}`]: () =>
        Response.json({ code: 'inventory.item_in_use', message: 'in use' }, { status: 409 }),
      [`POST /api/v1/inventory/items/${COLA.id}/purge`]: () => new Response(null, { status: 204 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    let cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    await userEvent.click(within(cola).getByTestId('item-delete'));
    let dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByTestId('confirm-fallback-note')).textContent).toContain(
      'cannot be undone',
    );
    expect(within(dialog).getByTestId('item-delete-fallback')).toBeTruthy();
    await userEvent.click(within(dialog).getByTestId('item-purge'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({
      method: 'POST',
      path: `/api/v1/inventory/items/${COLA.id}/purge`,
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    cleanup();

    // An admin: archive only.
    signedInAs('admin');
    api({
      [`DELETE /api/v1/inventory/items/${COLA.id}`]: () =>
        Response.json({ code: 'inventory.item_in_use', message: 'in use' }, { status: 409 }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    cola = screen.getAllByTestId('item-row').find((r) => r.dataset.name === 'Cola 0.33')!;
    const del = within(cola).queryByTestId('item-delete');
    if (del) {
      await userEvent.click(del);
      dialog = await screen.findByRole('alertdialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(await within(dialog).findByTestId('item-delete-fallback')).toBeTruthy();
      expect(within(dialog).queryByTestId('item-purge')).toBeNull();
    }
  });

  it('lets managers add warehouses but not items', async () => {
    signedInAs('manager');
    api();
    render(<InventoryPage />);
    await userEvent.click(await tab('items'));
    expect(screen.queryByTestId('item-create')).toBeNull();
    await userEvent.click(await tab('warehouses'));
    expect(screen.getAllByTestId('warehouse-row').map((r) => r.dataset.name)).toEqual([
      'Main store',
      'Bar',
    ]);
    expect(screen.getByTestId('warehouse-create')).toBeTruthy();
  });

  it('opens the warehouses of the branch a branch card links to, not all of them', async () => {
    signedInAs('owner');
    const NORTH = { id: id(2), name: 'North branch', brandId: id(90) };
    const SOUTH = { id: id(3), name: 'South branch', brandId: id(90) };
    api({
      'GET /api/v1/locations': () => Response.json({ data: [MAIN_LOCATION, NORTH, SOUTH] }),
      'GET /api/v1/inventory/warehouses': () =>
        Response.json({
          data: [
            {
              ...STORE,
              id: id(31),
              name: 'North store',
              locationId: NORTH.id,
              suppliesStation: null,
            },
            {
              ...STORE,
              id: id(32),
              name: 'South store',
              locationId: SOUTH.id,
              suppliesStation: null,
            },
          ],
        }),
    });
    mockState.search = `branch=${NORTH.id}`;
    render(<InventoryPage />);
    await userEvent.click(await tab('warehouses'));
    expect(screen.getAllByTestId('warehouse-row').map((r) => r.dataset.name)).toEqual([
      'North store',
    ]);
  });

  it('adds a warehouse that supplies only the branches ticked, moving one from another (ADR 0067)', async () => {
    signedInAs('owner');
    const NORTH = { id: id(2), name: 'North branch', brandId: id(90) };
    const SOUTH = { id: id(3), name: 'South branch', brandId: id(90) };
    const writes = api({
      'GET /api/v1/locations': () => Response.json({ data: [MAIN_LOCATION, NORTH, SOUTH] }),
      'GET /api/v1/inventory/warehouses': () =>
        Response.json({ data: [{ ...STORE, suppliesLocationIds: [SOUTH.id] }, BAR] }),
      'POST /api/v1/inventory/warehouses': () => Response.json(STORE),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('warehouses'));
    // The list says whom a warehouse supplies.
    expect(screen.getAllByTestId('warehouse-supplies').map((c) => c.textContent)).toContain(
      'South branch',
    );
    await userEvent.click(screen.getByTestId('warehouse-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Second warehouse');
    // Starts as no branch; choose some.
    expect(within(dialog).getByTestId<HTMLInputElement>('warehouse-supply-none').checked).toBe(
      true,
    );
    await userEvent.click(within(dialog).getByTestId('warehouse-supply-some'));
    // Nothing ticked: named, not sent.
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Tick at least one branch.')).toBeTruthy();
    // No location to choose: it gets a place of its own (ADR 0068), so every branch is offered; a branch supplied
    // elsewhere says from where.
    expect(within(dialog).queryByLabelText('Location')).toBeNull();
    const branches = within(dialog)
      .getAllByTestId('warehouse-supply-branch')
      .filter((b) => b.dataset.id !== MAIN_LOCATION.id);
    expect(branches.map((b) => b.dataset.id)).toEqual([NORTH.id, SOUTH.id]);
    expect(within(dialog).getByTestId('warehouse-supply-branches').textContent).toContain(
      'South branch · now from Main store',
    );
    await userEvent.click(branches[0]!);
    await userEvent.click(branches[1]!);
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(writes.find((w) => w.method === 'POST')?.body).toEqual({
        name: 'Second warehouse',
        suppliesLocationIds: [NORTH.id, SOUTH.id],
      }),
    );
  });

  it('makes a warehouse the main one, sending the switch only when it changes (ADR 0053)', async () => {
    signedInAs('owner');
    const writes = api({
      [`PATCH /api/v1/inventory/warehouses/${STORE.id}`]: () =>
        Response.json({ ...STORE, isMain: true }),
    });
    render(<InventoryPage />);
    await userEvent.click(await tab('warehouses'));
    const row = screen.getAllByTestId('warehouse-row')[0]!;
    await userEvent.click(within(row).getByTestId('warehouse-edit'));
    // "Which branches does it supply?" → every branch.
    await userEvent.click(await screen.findByTestId('warehouse-supply-all'));
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes.find((w) => w.method === 'PATCH')?.body).toEqual({
        name: 'Main store',
        suppliesStation: 'kitchen',
        isMain: true,
      }),
    );
  });
});
