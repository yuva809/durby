// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { AttributesPage, parseValues, valuesProblem } from './attributes-page';
import { BomsPage } from './boms-page';
import { InventoryPage } from './inventory-page';
import { ProductionPage } from './production-page';
import { UnitsPage } from './units-page';
import { combinationCount, VariantsPage } from './variants-page';

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

const id = (n: number) => `0190a000-0000-7000-8000-0000000020${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(1), name: 'Main street', brandId: id(90) };
const STORE = {
  id: id(10),
  locationId: LOCATION.id,
  name: 'Main store',
  sortOrder: 0,
  suppliesStation: null,
  archivedAt: null,
};
const item = (
  n: number,
  name: string,
  unit: string,
  variant?: { parent: string; values: string[] },
) => ({
  id: id(20 + n),
  name,
  sku: null,
  unit,
  minQuantity: null,
  parentItemId: variant?.parent ?? null,
  variantValues: variant?.values ?? [],
  archivedAt: null,
});
const TOMATOES = item(1, 'Tomatoes', 'kg');
const OIL = item(2, 'Oil', 'l');
const SAUCE = item(3, 'Tomato sauce', 'l');
const COLA = item(4, 'Cola', 'pc');
const SHIRT = item(5, 'Shirt', 'pc');
const SHIRT_S = item(6, 'Shirt · S', 'pc', { parent: SHIRT.id, values: ['S'] });
const CASE = {
  id: id(40),
  name: 'Case',
  symbol: 'cs',
  baseUnit: 'pc',
  factor: '24.000000',
  archivedAt: null,
};
const SIZE = { id: id(50), name: 'Size', values: ['S', 'M', 'L'], archivedAt: null };
const BILL = {
  itemId: SAUCE.id,
  itemName: SAUCE.name,
  unit: 'l',
  outputQuantity: '1.000',
  lines: [
    { itemId: OIL.id, itemName: 'Oil', unit: 'l', quantity: '0.100' },
    { itemId: TOMATOES.id, itemName: 'Tomatoes', unit: 'kg', quantity: '2.000' },
  ],
  updatedAt: '2026-11-13T10:00:00.000Z',
};
const level = (itemId: string, itemName: string, unit: string, quantity: string) => ({
  warehouseId: STORE.id,
  itemId,
  itemName,
  unit,
  quantity,
  averageCost: '1.0000',
  value: '0.00',
  low: false,
});
const document = (number: string, kind: string) => ({
  id: id(60),
  number,
  kind,
  warehouseId: STORE.id,
  warehouseName: STORE.name,
  toWarehouseId: null,
  toWarehouseName: null,
  reason: null,
  supplier: null,
  note: null,
  lineCount: 3,
  value: '0.00',
  createdAt: '2026-11-13T10:00:00.000Z',
  lines: [],
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['inventory', 'catalog'],
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
      'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
      'GET /api/v1/inventory/warehouses': () => Response.json({ data: [STORE] }),
      'GET /api/v1/inventory/items': () =>
        Response.json({ data: [TOMATOES, OIL, SAUCE, COLA, SHIRT, SHIRT_S] }),
      'GET /api/v1/inventory/units': () => Response.json({ data: [CASE] }),
      'GET /api/v1/inventory/attributes': () => Response.json({ data: [SIZE] }),
      'GET /api/v1/inventory/boms': () => Response.json({ data: [BILL] }),
      'GET /api/v1/inventory/stock': () =>
        Response.json({
          data: [level(TOMATOES.id, 'Tomatoes', 'kg', '4.500'), level(OIL.id, 'Oil', 'l', '2.000')],
        }),
      ...extra,
    };
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
  return writes;
}

describe('helpers', () => {
  it('parses comma-separated attribute values and finds problems', () => {
    expect(parseValues(' S, M ,, L ')).toEqual(['S', 'M', 'L']);
    expect(valuesProblem([])).toBe('empty');
    expect(valuesProblem(['S', 's'])).toBe('duplicate');
    expect(valuesProblem(['x'.repeat(41)])).toBe('tooLong');
    expect(valuesProblem(['S', 'M'])).toBeNull();
  });

  it('counts combinations as the product of picked values', () => {
    expect(combinationCount({})).toBe(0);
    expect(combinationCount({ a: ['S', 'L'], b: ['Red', 'Blue', 'Green'] })).toBe(6);
    expect(combinationCount({ a: ['S'], b: [] })).toBe(1);
  });
});

describe('Units of Measurement', () => {
  it('lists units as conversions and adds one', async () => {
    signedInAs('admin');
    const writes = api({
      'POST /api/v1/inventory/units': () =>
        Response.json(
          { ...CASE, id: id(41), name: 'Sack', symbol: 'sk', baseUnit: 'kg', factor: '25.000000' },
          { status: 201 },
        ),
    });
    render(<UnitsPage />);
    const row = await screen.findByTestId('unit-row');
    expect(row.textContent).toContain('1 cs = 24');
    await userEvent.click(screen.getByTestId('unit-create'));
    await userEvent.type(screen.getByTestId('unit-name'), 'Sack');
    await userEvent.type(screen.getByTestId('unit-symbol'), 'sk');
    await userEvent.type(screen.getByTestId('unit-factor'), '25');
    await userEvent.selectOptions(screen.getByTestId('unit-base'), 'kg');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes.find((w) => w.path === '/api/v1/inventory/units')?.body).toEqual({
        name: 'Sack',
        symbol: 'sk',
        factor: '25',
        baseUnit: 'kg',
      }),
    );
  });

  it('lets managers read units, not change them', async () => {
    signedInAs('manager');
    api();
    render(<UnitsPage />);
    await screen.findByTestId('unit-row');
    expect(screen.queryByTestId('unit-create')).toBeNull();
    expect(screen.queryByTestId('unit-edit')).toBeNull();
  });
});

describe('Variant Attributes', () => {
  it('adds an attribute with its values in order, refusing duplicates', async () => {
    signedInAs('admin');
    const writes = api({
      'POST /api/v1/inventory/attributes': () =>
        Response.json(
          { ...SIZE, id: id(51), name: 'Pack', values: ['0.33 l', '0.5 l'] },
          { status: 201 },
        ),
    });
    render(<AttributesPage />);
    expect((await screen.findByTestId('attribute-row')).textContent).toContain('Size');
    await userEvent.click(screen.getByTestId('attribute-create'));
    await userEvent.type(screen.getByTestId('attribute-name'), 'Pack');
    await userEvent.type(screen.getByTestId('attribute-values'), '0.33 l, 0.33 L');
    await userEvent.click(screen.getByTestId('form-save'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(writes).toHaveLength(0);
    await userEvent.clear(screen.getByTestId('attribute-values'));
    await userEvent.type(screen.getByTestId('attribute-values'), '0.33 l, 0.5 l');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes[0]?.body).toEqual({ name: 'Pack', values: ['0.33 l', '0.5 l'] }),
    );
  });
});

describe('Variant Products', () => {
  it('groups variants under their item and generates the picked combinations', async () => {
    signedInAs('admin');
    const writes = api({
      [`POST /api/v1/inventory/items/${COLA.id}/variants`]: () =>
        Response.json(
          {
            created: [item(7, 'Cola · S', 'pc', { parent: COLA.id, values: ['S'] })],
            skipped: 1,
          },
          { status: 201 },
        ),
    });
    render(<VariantsPage />);
    const parent = await screen.findByTestId('variant-parent');
    expect(parent.textContent).toContain('Shirt');
    expect(within(parent).getAllByTestId('variant-row')).toHaveLength(1);

    await userEvent.click(screen.getByTestId('variants-generate'));
    await userEvent.selectOptions(screen.getByTestId('variants-item'), COLA.id);
    await userEvent.click(screen.getByTestId('variants-attribute'));
    expect(screen.getByTestId('variants-count').textContent).toContain('3');
    const value = (v: string) =>
      screen.getAllByTestId('variants-value').find((c) => c.dataset.value === v)!;
    await userEvent.click(value('M'));
    expect(screen.getByTestId('variants-count').textContent).toContain('2');
    await userEvent.type(screen.getByTestId('variants-prefix'), 'COLA');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes[0]?.body).toEqual({
        attributes: [{ attributeId: SIZE.id, values: ['S', 'L'] }],
        skuPrefix: 'COLA',
      }),
    );
    expect(await screen.findByText(/1 variants created, 1 already existed/)).toBeTruthy();
  });
});

describe('Bills of Materials', () => {
  it('shows each bill with its ingredients and adds one', async () => {
    signedInAs('manager');
    const writes = api({
      [`PUT /api/v1/inventory/boms/${COLA.id}`]: () => Response.json({ ...BILL, itemId: COLA.id }),
    });
    render(<BomsPage />);
    const card = await screen.findByTestId('bom-card');
    expect(card.textContent).toContain('Tomato sauce');
    expect(card.textContent).toContain('Tomatoes');
    await userEvent.click(screen.getByTestId('bom-create'));
    // The parent with variants (Shirt) holds no stock: not offered.
    const options = within(screen.getByTestId('bom-item'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).not.toContain('Shirt');
    expect(options).not.toContain('Tomato sauce'); // already has a bill
    await userEvent.selectOptions(screen.getByTestId('bom-item'), COLA.id);
    await userEvent.clear(screen.getByTestId('bom-output'));
    await userEvent.type(screen.getByTestId('bom-output'), '2');
    await userEvent.selectOptions(screen.getAllByTestId('bom-line-item')[0]!, OIL.id);
    await userEvent.type(screen.getAllByTestId('bom-line-quantity')[0]!, '0.5');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes[0]).toEqual({
        method: 'PUT',
        path: `/api/v1/inventory/boms/${COLA.id}`,
        body: { outputQuantity: '2', lines: [{ itemId: OIL.id, quantity: '0.5' }] },
      }),
    );
  });

  it('hides editing from staff', async () => {
    signedInAs('staff');
    api();
    render(<BomsPage />);
    await screen.findByTestId('bom-card');
    expect(screen.queryByTestId('bom-create')).toBeNull();
    expect(screen.queryByTestId('bom-delete')).toBeNull();
  });
});

describe('Production Order', () => {
  it('previews what it takes against stock, then produces', async () => {
    signedInAs('kitchen');
    const writes = api({
      'POST /api/v1/inventory/productions': () =>
        Response.json(document('PRD-2026-000001', 'production'), { status: 201 }),
    });
    render(<ProductionPage />);
    await userEvent.type(await screen.findByTestId('production-quantity'), '3');
    const needs = await screen.findAllByTestId('production-need');
    // 3 l: 0.3 l oil (2 on hand), 6 kg tomatoes (4.5 on hand → short).
    expect(needs.map((n) => [n.textContent?.includes('Tomatoes'), n.dataset.short])).toEqual([
      [false, 'false'],
      [true, 'true'],
    ]);
    await userEvent.click(screen.getByTestId('production-post'));
    await waitFor(() =>
      expect(writes[0]?.body).toEqual({ warehouseId: STORE.id, itemId: SAUCE.id, quantity: '3' }),
    );
    expect(await screen.findByText(/PRD-2026-000001/)).toBeTruthy();
  });

  it('does not let staff produce', async () => {
    signedInAs('staff');
    api();
    render(<ProductionPage />);
    expect((await screen.findByTestId<HTMLButtonElement>('production-post')).disabled).toBe(true);
  });
});

describe('Receive in a unit of measurement', () => {
  it('offers the units of the item, sends the unit and hides parents with variants', async () => {
    signedInAs('owner');
    const writes = api({
      'POST /api/v1/inventory/receipts': () =>
        Response.json(document('GR-2026-000001', 'receipt'), { status: 201 }),
    });
    render(<InventoryPage tab="receive" />);
    const itemSelect = await screen.findByTestId('doc-item');
    const names = within(itemSelect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toContain('Shirt · S');
    expect(names).not.toContain('Shirt');
    // Tomatoes (kg): no unit in kg, no unit picker.
    await userEvent.selectOptions(itemSelect, TOMATOES.id);
    expect(screen.queryByTestId('doc-unit')).toBeNull();
    await userEvent.selectOptions(itemSelect, COLA.id);
    await userEvent.selectOptions(screen.getByTestId('doc-unit'), CASE.id);
    await userEvent.type(screen.getByTestId('doc-quantity'), '2');
    await userEvent.type(screen.getByTestId('doc-cost'), '12');
    await userEvent.click(screen.getByTestId('doc-post'));
    await waitFor(() =>
      expect(writes[0]?.body).toMatchObject({
        warehouseId: STORE.id,
        lines: [{ itemId: COLA.id, quantity: '2', unitCost: '12', unitId: CASE.id }],
      }),
    );
  });
});
