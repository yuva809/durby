// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { MyDeliveriesPage } from './my-deliveries-page';
import { RequestStockPage } from './request-stock-page';
import { RequestsPage } from './requests-page';
import { TransfersPicking } from './transfers-picking';

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

const id = (n: number) => `0190a000-0000-7000-8000-0000000010${String(n).padStart(2, '0')}`;
const MAIN = {
  id: id(1),
  name: 'Main Warehouse',
  locationId: id(2),
  locationName: 'Head office',
  canRequestInto: false,
};
const BRANCH = {
  id: id(3),
  name: 'Store',
  locationId: id(4),
  locationName: 'Kurfürstenstraße',
  canRequestInto: true,
};
const line = (n: number, name: string, extra: Record<string, string | null> = {}) => ({
  id: id(40 + n),
  itemId: id(50 + n),
  itemName: name,
  unit: 'pc',
  quantity: '6.000',
  approvedQuantity: null,
  pickedQuantity: null,
  receivedQuantity: null,
  ...extra,
});
const request = (status: string, extra: Record<string, unknown> = {}) => ({
  id: id(10),
  number: 'SRQ-2026-000047',
  transferNumber: status === 'submitted' ? null : 'TRF-2026-000047',
  status,
  fromWarehouseId: MAIN.id,
  fromWarehouseName: MAIN.name,
  fromLocationName: MAIN.locationName,
  toWarehouseId: BRANCH.id,
  toWarehouseName: BRANCH.name,
  locationId: BRANCH.locationId,
  locationName: BRANCH.locationName,
  lineCount: 2,
  driverUserId: null,
  driverName: null,
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T09:00:00.000Z',
  note: null,
  lines: [line(1, 'Rice'), line(2, 'Oil')],
  events: [
    {
      id: id(30),
      status: 'submitted',
      note: null,
      userId: null,
      createdAt: '2026-11-13T09:00:00.000Z',
    },
  ],
  ...extra,
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['inventory', 'catalog', 'orders'],
  });
}

/** The request cart's setup (ADR 0053): source warehouses and the branches to request for. */
const setup = {
  warehouses: [MAIN, BRANCH] as Record<string, unknown>[],
  destinations: [
    {
      locationId: BRANCH.locationId,
      locationName: BRANCH.locationName,
      warehouseId: BRANCH.id as string | null,
      warehouseName: BRANCH.name as string | null,
    },
  ],
};

/** `detail` answers GET /stock-requests/:id and every list; writes are recorded. */
function api(detail: ReturnType<typeof request>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: input, body: init?.body ? JSON.parse(init.body as string) : null });
    if (method === 'POST')
      return Promise.resolve(Response.json({ ...detail, number: 'SRQ-2026-000048' }));
    if (input === '/api/v1/stock-requests/warehouses')
      return Promise.resolve(Response.json({ data: setup.warehouses }));
    if (input === '/api/v1/stock-requests/destinations')
      return Promise.resolve(Response.json({ data: setup.destinations }));
    if (input.startsWith('/api/v1/stock-requests/availability/')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              itemId: id(51),
              itemName: 'Rice',
              sku: 'R-1',
              unit: 'pc',
              available: '10.000',
              categoryId: id(70),
              categoryName: 'Dry goods',
            },
            {
              itemId: id(52),
              itemName: 'Oil',
              sku: null,
              unit: 'pc',
              available: '0.000',
              categoryId: null,
              categoryName: null,
            },
          ],
        }),
      );
    }
    if (input.startsWith('/api/v1/stock-requests/drivers/'))
      return Promise.resolve(Response.json({ data: [{ userId: id(60), name: 'Ali' }] }));
    if (input === `/api/v1/stock-requests/${detail.id}`)
      return Promise.resolve(Response.json(detail));
    if (input.startsWith('/api/v1/stock-requests'))
      return Promise.resolve(Response.json({ data: [detail] }));
    return Promise.resolve(Response.json({ data: [] }));
  });
  return calls;
}

const posts = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === 'POST');

describe('Request stock cart (branch, ADR 0053)', () => {
  beforeEach(() => {
    localStorage.clear();
    setup.warehouses = [{ ...MAIN, isMain: true }, BRANCH];
    setup.destinations[0]!.warehouseId = BRANCH.id;
    setup.destinations[0]!.warehouseName = BRANCH.name;
  });

  it('fills a cart from the main warehouse and sends it for the branch', async () => {
    signedInAs('branch');
    const calls = api(request('submitted'));
    render(<RequestStockPage />);
    const cards = await screen.findAllByTestId('request-item');
    // In stock first; quantities only, never prices.
    expect(cards.map((c) => c.textContent)).toEqual([
      'RRiceR-110 pc availableAdd',
      'OOilOut of stockAdd',
    ]);
    expect(screen.getByTestId('request-from-main').textContent).toContain('Main Warehouse');
    expect(screen.queryByTestId('request-from')).toBeNull();

    await userEvent.click(within(cards[0]!).getByTestId('request-add'));
    await userEvent.click(within(cards[0]!).getByTestId('request-more'));
    expect(within(cards[0]!).getByTestId<HTMLInputElement>('request-quantity').value).toBe('2');
    expect(screen.getByTestId('request-cart-count').textContent).toContain('1 items');

    await userEvent.click(screen.getByTestId('request-cart-open'));
    const cart = await screen.findByTestId('request-cart');
    expect(within(cart).getAllByTestId('request-cart-line')).toHaveLength(1);
    await userEvent.type(within(cart).getByTestId('request-note'), 'For the weekend');
    await userEvent.click(within(cart).getByTestId('request-submit'));
    await waitFor(() =>
      expect(posts(calls)[0]).toEqual({
        method: 'POST',
        path: '/api/v1/stock-requests',
        body: {
          toWarehouseId: BRANCH.id,
          lines: [{ itemId: id(51), quantity: '2' }],
          note: 'For the weekend',
        },
      }),
    );
    expect((await screen.findByTestId('request-sent')).textContent).toContain(
      'Request SRQ-2026-000048 sent',
    );
    expect(screen.queryByTestId('request-cart-count')).toBeNull();
  });

  it('asks by branch when it has no store yet, and lets it pick the source without a main warehouse', async () => {
    signedInAs('branch');
    setup.warehouses = [MAIN, BRANCH];
    setup.destinations[0]!.warehouseId = null;
    setup.destinations[0]!.warehouseName = null;
    const calls = api(request('submitted'));
    render(<RequestStockPage />);
    expect((await screen.findByTestId<HTMLSelectElement>('request-from')).value).toBe(MAIN.id);
    const oil = (await screen.findAllByTestId('request-item'))[1]!;
    await userEvent.click(within(oil).getByTestId('request-add'));
    await userEvent.click(screen.getByTestId('request-cart-open'));
    const cart = await screen.findByTestId('request-cart');
    expect(cart.textContent).toContain('has no store yet');
    await userEvent.click(within(cart).getByTestId('request-submit'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toEqual({
        fromWarehouseId: MAIN.id,
        toLocationId: BRANCH.locationId,
        lines: [{ itemId: id(52), quantity: '1' }],
      }),
    );
  });

  it('filters by category and search, and keeps the cart for the next visit', async () => {
    signedInAs('branch');
    api(request('submitted'));
    render(<RequestStockPage />);
    await screen.findAllByTestId('request-item');
    const chips = screen.getAllByTestId('request-category');
    expect(chips.map((c) => c.textContent)).toEqual(['All', 'Dry goods1', 'Other1']);
    await userEvent.click(chips[2]!);
    expect(screen.getAllByTestId('request-item').map((c) => c.dataset.item)).toEqual([id(52)]);
    await userEvent.click(chips[0]!);
    await userEvent.type(screen.getByTestId('request-search'), 'r-1');
    expect(screen.getAllByTestId('request-item').map((c) => c.dataset.item)).toEqual([id(51)]);
    await userEvent.click(screen.getByTestId('request-add'));

    cleanup();
    render(<RequestStockPage />);
    expect(await screen.findByTestId('request-cart-count')).toBeTruthy();
  });
});

describe('Stock Requests', () => {
  it('lets the owner approve with changed quantities', async () => {
    signedInAs('owner');
    const calls = api(request('submitted'));
    render(<RequestsPage />);
    await userEvent.click(await screen.findByTestId('request-row'));
    const panel = await screen.findByTestId('request-panel');
    await userEvent.click(await within(panel).findByTestId('request-approve'));
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
    const inputs = within(dialog).getAllByTestId<HTMLInputElement>('request-approve-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['6', '6']);
    await userEvent.clear(inputs[1]!);
    await userEvent.type(inputs[1]!, '0');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(posts(calls)[0]).toEqual({
        method: 'POST',
        path: `/api/v1/stock-requests/${id(10)}/approve`,
        body: {
          lines: [
            { lineId: id(41), quantity: '6' },
            { lineId: id(42), quantity: '0' },
          ],
        },
      }),
    );
  });

  it('lets a branch confirm what arrived, no more than was packed', async () => {
    signedInAs('branch');
    const calls = api(
      request('delivered', {
        lines: [
          line(1, 'Rice', { approvedQuantity: '5.000', pickedQuantity: '4.000' }),
          line(2, 'Oil', { approvedQuantity: '0.000', pickedQuantity: '0.000' }),
        ],
      }),
    );
    render(<RequestsPage />);
    await userEvent.click(screen.getByTestId('requests-tab-progress'));
    await userEvent.click(await screen.findByTestId('request-row'));
    const panel = await screen.findByTestId('request-panel');
    expect(within(panel).queryByTestId('request-approve')).toBeNull();
    await userEvent.click(await within(panel).findByTestId('request-receive'));
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
    const inputs = within(dialog).getAllByTestId<HTMLInputElement>('request-receive-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['4']);
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, '5');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(await within(dialog).findByText(/up to the given amount/)).toBeTruthy();
    expect(posts(calls)).toEqual([]);
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, '3');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toEqual({ lines: [{ lineId: id(41), quantity: '3' }] }),
    );
  });
});

describe('Transfers on the Picking page (warehouse)', () => {
  it('packs the approved lines with a driver', async () => {
    signedInAs('warehouse');
    const calls = api(
      request('approved', {
        lines: [
          line(1, 'Rice', { approvedQuantity: '5.000' }),
          line(2, 'Oil', { approvedQuantity: '0.000' }),
        ],
      }),
    );
    render(<TransfersPicking organizationId={mockState.session!.activeOrganizationId} />);
    const row = await screen.findByTestId('transfer-row');
    expect(row.textContent).toContain('TRF-2026-000047');
    await userEvent.click(await within(row).findByTestId('transfer-pack'));
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
    const inputs = within(dialog).getAllByTestId<HTMLInputElement>('transfer-pack-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['5']);
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, '4');
    await waitFor(() => expect(within(dialog).getByText('Ali')).toBeTruthy());
    await userEvent.selectOptions(within(dialog).getByTestId('transfer-driver'), id(60));
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(posts(calls)[0]).toEqual({
        method: 'POST',
        path: `/api/v1/stock-requests/${id(10)}/pack`,
        body: { lines: [{ lineId: id(41), quantity: '4' }], driverUserId: id(60) },
      }),
    );
  });
});

describe('My Deliveries (driver)', () => {
  it('lists only the driver’s own deliveries and marks one picked up', async () => {
    signedInAs('driver');
    const calls = api(request('packed', { driverUserId: id(60), driverName: 'Ali' }));
    render(<MyDeliveriesPage />);
    const card = await screen.findByTestId('delivery-card');
    expect(calls.some((c) => c.path.includes('mine=true'))).toBe(true);
    await userEvent.click(within(card).getByTestId('delivery-pick-up'));
    await userEvent.click(await screen.findByRole('button', { name: 'Picked up' }));
    await waitFor(() =>
      expect(posts(calls)[0]?.path).toBe(`/api/v1/stock-requests/${id(10)}/pick-up`),
    );
  });

  it('needs orders.delivery.use', () => {
    signedInAs('branch');
    render(<MyDeliveriesPage />);
    expect(screen.queryByTestId('my-deliveries')).toBeNull();
  });
});
