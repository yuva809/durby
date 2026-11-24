// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { ItemActivityPage } from './item-activity';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000030${String(n).padStart(2, '0')}`;
const warehouse = (n: number, name: string) => ({
  id: id(n),
  locationId: id(90),
  name,
  sortOrder: 0,
  suppliesStation: null,
  suppliesLocationIds: [],
  isMain: n === 1,
  isTransit: false,
  archivedAt: null,
});
const MAIN = warehouse(1, 'Main Warehouse');
const BAR = warehouse(2, 'Bar');
const NOODLES = {
  id: id(10),
  name: 'NOODLES INDOMIE CHICK KAD',
  sku: 'N-1',
  unit: 'box',
  minQuantity: null,
  categoryId: null,
  archivedAt: null,
};
const movement = (
  n: number,
  kind: string,
  quantity: string,
  balance: string,
  extra: Record<string, unknown> = {},
) => ({
  id: id(40 + n),
  createdAt: `2026-11-${String(n + 4).padStart(2, '0')}T10:00:00.000Z`,
  documentId: id(60 + n),
  documentNumber: `DOC-${n}`,
  kind,
  reason: null,
  warehouseId: MAIN.id,
  warehouseName: MAIN.name,
  quantity,
  unitCost: '2.5000',
  remarks: null,
  balance,
  ...extra,
});

function api() {
  const paths: string[] = [];
  mockState.store.apiFetch.mockImplementation((input: string) => {
    paths.push(input);
    const path = input.replace(/\?.*$/, '');
    const answers: Record<string, unknown> = {
      '/api/v1/inventory/items': { data: [NOODLES] },
      '/api/v1/inventory/warehouses': { data: [MAIN, BAR] },
      '/api/v1/inventory/stock': { data: [] },
      [`/api/v1/inventory/items/${NOODLES.id}/movements`]: {
        opening: '0.000',
        closing: '120.000',
        truncated: false,
        movements: [
          movement(3, 'transfer', '-10.000', '120.000', { remarks: 'Transfer TRF-16 packed' }),
          movement(2, 'adjustment', '-20.000', '130.000', { reason: 'waste' }),
          movement(1, 'receipt', '150.000', '150.000', { remarks: 'Unidex' }),
        ],
      },
    };
    return Promise.resolve(Response.json(answers[path] ?? { data: [] }));
  });
  return paths;
}

describe('item activity page', () => {
  it("lists an item's movements with in, out, the balance after each, and filters by warehouse", async () => {
    mockState.session = sessionFixture({
      activePermissions: [...systemRolePermissions('owner')],
      activeFeatures: ['inventory'],
    });
    const paths = api();
    render(<ItemActivityPage itemId={NOODLES.id} />);
    expect((await screen.findByTestId('item-activity-name')).textContent).toBe(
      'NOODLES INDOMIE CHICK KAD',
    );
    const rows = await screen.findAllByTestId('item-activity-row');
    expect(
      rows.map((r) => [
        within(r).getByTestId('item-activity-type').textContent,
        within(r).getByTestId('item-activity-in').textContent,
        within(r).getByTestId('item-activity-out').textContent,
        within(r).getByTestId('item-activity-balance').textContent,
      ]),
    ).toEqual([
      ['Transfer out', '', '10', '120'],
      ['Waste', '', '20', '130'],
      ['Receipt', '150', '', '150'],
    ]);
    expect(rows[0]!.textContent).toContain('Transfer TRF-16 packed');
    expect(screen.getByTestId('item-activity-summary').textContent).toBe(
      'Opening 0 · Closing 120 box',
    );
    await userEvent.selectOptions(screen.getByTestId('item-activity-warehouse'), BAR.id);
    await waitFor(() =>
      expect(paths).toContain(
        `/api/v1/inventory/items/${NOODLES.id}/movements?warehouseId=${BAR.id}`,
      ),
    );
  });

  it('needs inventory.stock.read', () => {
    mockState.session = sessionFixture({ activePermissions: [], activeFeatures: ['inventory'] });
    api();
    render(<ItemActivityPage itemId={NOODLES.id} />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});
