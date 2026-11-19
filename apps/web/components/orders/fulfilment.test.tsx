// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { DeliveriesPage } from './deliveries-page';
import { PickingPage } from './picking-page';

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

const id = (n: number) => `0190a000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;
const order = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: id(10 + n),
  number: `SO-2026-00000${n}`,
  status,
  customerId: id(1),
  customerName: `Customer ${n}`,
  locationId: id(2),
  locationName: 'KL Central',
  warehouseId: id(3),
  warehouseName: 'Main',
  requestedDate: null,
  lineCount: 2,
  total: '50.00',
  deliveryAddress: '12 Jalan Ampang',
  driverName: null,
  dispatchedAt: null,
  deliveredAt: null,
  createdAt: `2026-11-1${n}T09:00:00.000Z`,
  updatedAt: `2026-11-1${n}T09:00:00.000Z`,
  ...extra,
});
const line = (n: number, name: string, quantity: string) => ({
  id: id(40 + n),
  itemId: id(50 + n),
  itemName: name,
  unit: 'pc',
  quantity,
  unitPrice: '10.00',
  lineTotal: '10.00',
  pickedQuantity: null,
});
const detail = (n: number, status: string) => ({
  ...order(n, status),
  note: null,
  driverPhone: null,
  vehicle: null,
  lines: [line(1, 'Rice', '3.000'), line(2, 'Oil', '1.500')],
  events: [],
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['inventory', 'catalog', 'orders'],
  });
}

/** What the order's warehouse has: plenty unless a test says otherwise. */
const level = (itemId: string, quantity: string) => ({
  warehouseId: id(1),
  itemId,
  itemName: '',
  unit: 'pc',
  quantity,
  averageCost: '1.0000',
  value: '1.00',
  low: false,
});
let stock = [level(id(51), '10.000'), level(id(52), '10.000')];

function api(lists: Record<string, unknown[]>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: input,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    const [path, search = ''] = input.split('?');
    if (method === 'POST') return Promise.resolve(Response.json(detail(1, 'packed')));
    if (path === '/api/v1/orders') {
      const key = new URLSearchParams(search).getAll('status').join(',');
      return Promise.resolve(
        Response.json({ data: lists[key] ?? [], meta: { nextCursor: null, limit: 200 } }),
      );
    }
    if (path?.startsWith('/api/v1/orders/'))
      return Promise.resolve(Response.json(detail(1, 'picking')));
    if (path === '/api/v1/inventory/stock') return Promise.resolve(Response.json({ data: stock }));
    return Promise.resolve(Response.json({ data: [] }));
  });
  return calls;
}

describe('Picking (/picking)', () => {
  it('needs orders.picking.use', () => {
    signedInAs('staff');
    render(<PickingPage />);
    expect(screen.queryByTestId('picking-queue')).toBeNull();
  });

  it('lists confirmed and picking orders, oldest first', async () => {
    signedInAs('manager');
    const calls = api({ 'confirmed,picking': [order(2, 'picking'), order(1, 'confirmed')] });
    render(<PickingPage />);
    const cards = await screen.findAllByTestId('picking-card');
    expect(cards.map((c) => within(c).getByText(/SO-2026/).textContent)).toEqual([
      'SO-2026-000001',
      'SO-2026-000002',
    ]);
    expect(within(cards[0]!).getByTestId('picking-start')).toBeTruthy();
    expect(within(cards[1]!).queryByTestId('picking-start')).toBeNull();
    expect(calls.some((c) => c.path.includes('/orders?status=confirmed&status=picking'))).toBe(
      true,
    );
  });

  it('picks against what is in stock, naming the shortage (items 16, 18)', async () => {
    signedInAs('manager');
    // Rice: 2 of the 3 ordered; oil: plenty.
    stock = [level(id(51), '2.000'), level(id(52), '10.000')];
    api({ 'confirmed,picking': [order(1, 'picking')] });
    render(<PickingPage />);
    await userEvent.click(await screen.findByTestId('picking-pick'));
    const dialog = await screen.findByRole('dialog');
    const inputs = await within(dialog).findAllByTestId<HTMLInputElement>('pick-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['2', '1.5']);
    expect(
      within(dialog)
        .getAllByTestId('pick-available')
        .map((c) => c.textContent),
    ).toEqual(['2 pc', '10 pc']);
    expect(within(dialog).getByTestId('pick-line-short').textContent).toBe('Short 1 pc');
    expect(within(dialog).getByTestId('pick-shortage').textContent).toContain(
      'Rice (2 pc in stock)',
    );
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, '3');
    expect(within(dialog).getByTestId('pick-beyond').textContent).toContain('Rice (2 pc in stock)');
    stock = [level(id(51), '10.000'), level(id(52), '10.000')];
  });

  it('picks with the ordered quantities filled in, short lines allowed, over-picking refused', async () => {
    signedInAs('manager');
    const calls = api({ 'confirmed,picking': [order(1, 'picking')] });
    render(<PickingPage />);
    await userEvent.click(await screen.findByTestId('picking-pick'));
    const dialog = await screen.findByRole('dialog');
    const inputs = await within(dialog).findAllByTestId<HTMLInputElement>('pick-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['3', '1.5']);

    await userEvent.clear(inputs[1]!);
    await userEvent.type(inputs[1]!, '2');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(
      await within(dialog).findByText(
        'Enter what was picked: up to the ordered quantity, with up to 3 decimals.',
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.clear(inputs[1]!);
    await userEvent.type(inputs[1]!, '0');
    expect(within(dialog).getByTestId('pick-short').textContent).toContain('1 short');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/v1/orders/${id(11)}/pick`,
        body: {
          lines: [
            { lineId: id(41), quantity: '3' },
            { lineId: id(42), quantity: '0' },
          ],
        },
      }),
    );
  });
});

describe('Delivery Tracking (/deliveries)', () => {
  const board = {
    'packed,dispatched': [
      order(3, 'dispatched', { driverName: 'Ali', dispatchedAt: '2026-11-15T10:00:00.000Z' }),
      order(2, 'packed'),
    ],
    delivered: [order(1, 'delivered', { deliveredAt: '2026-11-14T10:00:00.000Z' })],
  };

  it('shows ready, on the way and delivered in their columns', async () => {
    signedInAs('manager');
    api(board);
    render(<DeliveriesPage />);
    const ready = await screen.findByTestId('delivery-ready');
    expect(within(ready).getByText('SO-2026-000002')).toBeTruthy();
    const onTheWay = screen.getByTestId('delivery-on-the-way');
    expect(within(onTheWay).getByText('Driver: Ali')).toBeTruthy();
    const delivered = await screen.findByTestId('delivery-delivered');
    expect(within(delivered).getByText('SO-2026-000001')).toBeTruthy();
  });

  it('dispatches with the driver details that were entered', async () => {
    signedInAs('manager');
    const calls = api(board);
    render(<DeliveriesPage />);
    await userEvent.click(await screen.findByTestId('delivery-dispatch'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('dispatch-driverName'), 'Ali');
    await userEvent.type(within(dialog).getByTestId('dispatch-vehicle'), 'WXY 1234');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/v1/orders/${id(12)}/dispatch`,
        body: { driverName: 'Ali', vehicle: 'WXY 1234' },
      }),
    );
  });

  it('marks an order delivered, or back with a reason', async () => {
    signedInAs('manager');
    const calls = api(board);
    render(<DeliveriesPage />);
    await userEvent.click(await screen.findByTestId('delivery-return'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The picked goods go back into Main.')).toBeTruthy();
    await userEvent.type(within(dialog).getByTestId('delivery-note'), 'Shop closed');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/v1/orders/${id(13)}/return`,
        body: { note: 'Shop closed' },
      }),
    );
  });
});
