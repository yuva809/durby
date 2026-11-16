// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { CustomersPage } from './customers-page';
import { OrdersPage } from './orders-page';

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

const id = (n: number) => `0190a000-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(1), name: 'KL Central' };
const WAREHOUSE = {
  id: id(2),
  locationId: LOCATION.id,
  name: 'Main',
  sortOrder: 0,
  suppliesStation: null,
  archivedAt: null,
};
const CUSTOMER = {
  id: id(3),
  name: 'Lotus Mart',
  code: 'C-001',
  phone: null,
  email: null,
  address: '12 Jalan Ampang',
  note: null,
  archivedAt: null,
};
const RICE = {
  id: id(4),
  name: 'Rice 5 kg',
  sku: null,
  unit: 'pc',
  minQuantity: null,
  parentItemId: null,
  variantValues: [],
  salePrice: '12.90',
  archivedAt: null,
};
const summary = (n: number, status: string, customerName = 'Lotus Mart') => ({
  id: id(10 + n),
  number: `SO-2026-00000${n}`,
  status,
  customerId: CUSTOMER.id,
  customerName,
  locationId: LOCATION.id,
  locationName: LOCATION.name,
  warehouseId: WAREHOUSE.id,
  warehouseName: WAREHOUSE.name,
  requestedDate: null,
  lineCount: 1,
  total: '38.70',
  createdAt: '2026-11-15T09:00:00.000Z',
  updatedAt: '2026-11-15T09:00:00.000Z',
});
const DRAFT = summary(1, 'draft');
const DELIVERED = summary(2, 'delivered', 'Sunrise Grocers');
const detail = (status = 'draft') => ({
  ...DRAFT,
  status,
  deliveryAddress: null,
  note: null,
  lines: [
    {
      id: id(30),
      itemId: RICE.id,
      itemName: RICE.name,
      unit: 'pc',
      quantity: '3.000',
      unitPrice: '12.90',
      lineTotal: '38.70',
    },
  ],
  events: [
    {
      id: id(31),
      status: 'draft',
      note: null,
      userId: null,
      createdAt: '2026-11-15T09:00:00.000Z',
    },
  ],
});

function signedInAs(role: SystemRole, permissions?: string[]) {
  mockState.session = sessionFixture({
    activePermissions: permissions ?? [...systemRolePermissions(role)],
    activeFeatures: ['inventory', 'catalog', 'orders'],
  });
}

/** Answers the reads; records writes and answers them with the order (or customer). */
function api(orders = [DRAFT, DELIVERED], nextCursor: string | null = null) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const [path, search = ''] = input.split('?');
    calls.push({
      method,
      path: `${path}${search ? `?${search}` : ''}`,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (method === 'POST' && path === '/api/v1/orders/customers') {
      return Promise.resolve(Response.json({ ...CUSTOMER, id: id(9), name: 'New Shop' }));
    }
    if (method === 'POST' && path?.endsWith('/cancel'))
      return Promise.resolve(Response.json(detail('cancelled')));
    if (method === 'POST' && path?.endsWith('/confirm'))
      return Promise.resolve(Response.json(detail('confirmed')));
    if (method === 'POST') return Promise.resolve(Response.json(detail('confirmed')));
    if (path === '/api/v1/orders') {
      return Promise.resolve(Response.json({ data: orders, meta: { nextCursor, limit: 50 } }));
    }
    if (path === `/api/v1/orders/${DRAFT.id}`) return Promise.resolve(Response.json(detail()));
    if (path === '/api/v1/orders/customers')
      return Promise.resolve(Response.json({ data: [CUSTOMER] }));
    if (path === '/api/v1/locations') return Promise.resolve(Response.json({ data: [LOCATION] }));
    if (path === '/api/v1/inventory/warehouses')
      return Promise.resolve(Response.json({ data: [WAREHOUSE] }));
    if (path === '/api/v1/inventory/items') return Promise.resolve(Response.json({ data: [RICE] }));
    return Promise.resolve(Response.json({ data: [] }));
  });
  return calls;
}

const listCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/v1/orders?'));

describe('Order History (/orders, ADR 0044)', () => {
  it('shows no access without orders.orders.read', () => {
    signedInAs('staff', []);
    render(<OrdersPage />);
    expect(screen.queryByTestId('orders-table')).toBeNull();
  });

  it('lists orders with customer, branch, total and status', async () => {
    signedInAs('owner');
    api();
    render(<OrdersPage />);
    const rows = await screen.findAllByTestId('order-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('SO-2026-000001')).toBeTruthy();
    expect(within(rows[0]!).getByText('KL Central · Main')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('order-status').textContent).toBe('Draft');
    expect(within(rows[1]!).getByTestId('order-status').textContent).toBe('Delivered');
  });

  it('searches the loaded orders without asking the api again', async () => {
    signedInAs('owner');
    const calls = api();
    render(<OrdersPage />);
    await screen.findAllByTestId('order-row');
    const before = listCalls(calls).length;
    await userEvent.type(screen.getByTestId('orders-search'), 'sunrise');
    expect(screen.getAllByTestId('order-row')).toHaveLength(1);
    expect(listCalls(calls)).toHaveLength(before);
  });

  it('sends the status filter to the api', async () => {
    signedInAs('owner');
    const calls = api();
    render(<OrdersPage />);
    await screen.findAllByTestId('order-row');
    await userEvent.selectOptions(screen.getByTestId('orders-status'), 'draft');
    await waitFor(() =>
      expect(listCalls(calls).some((c) => c.path.includes('status=draft'))).toBe(true),
    );
  });

  it('loads more with the cursor', async () => {
    signedInAs('owner');
    const calls = api([DRAFT], 'next-page');
    render(<OrdersPage />);
    await userEvent.click(await screen.findByTestId('orders-more'));
    await waitFor(() =>
      expect(listCalls(calls).some((c) => c.path.includes('cursor=next-page'))).toBe(true),
    );
  });

  it('creates an order: sale price filled in, exact total, confirmed at once', async () => {
    signedInAs('owner');
    const calls = api();
    render(<OrdersPage />);
    await userEvent.click(await screen.findByTestId('order-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByTestId('order-customer'), CUSTOMER.id);
    // The customer's address is offered as the delivery address; the only warehouse is picked.
    expect(within(dialog).getByTestId<HTMLInputElement>('order-address').value).toBe(
      '12 Jalan Ampang',
    );
    expect(within(dialog).getByTestId<HTMLSelectElement>('order-warehouse').value).toBe(
      WAREHOUSE.id,
    );
    await userEvent.selectOptions(within(dialog).getByTestId('order-add-item'), RICE.id);
    expect(within(dialog).getByTestId<HTMLInputElement>('order-line-price').value).toBe('12.90');
    const quantity = within(dialog).getByTestId('order-line-quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '3');
    expect(within(dialog).getByTestId('order-total').textContent).toContain('38.70');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/orders')?.body).toEqual({
        customerId: CUSTOMER.id,
        warehouseId: WAREHOUSE.id,
        lines: [{ itemId: RICE.id, quantity: '3', unitPrice: '12.90' }],
        deliveryAddress: '12 Jalan Ampang',
        confirm: true,
      }),
    );
  });

  it('refuses to send an order without items', async () => {
    signedInAs('owner');
    const calls = api();
    render(<OrdersPage />);
    await userEvent.click(await screen.findByTestId('order-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByTestId('order-customer'), CUSTOMER.id);
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(await within(dialog).findByText('Add at least one item.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('opens an order with its lines and timeline, and confirms a draft', async () => {
    signedInAs('owner');
    const calls = api();
    render(<OrdersPage />);
    await userEvent.click((await screen.findAllByTestId('order-open'))[0]!);
    const panel = await screen.findByTestId('order-detail');
    expect(await within(panel).findByText('Rice 5 kg')).toBeTruthy();
    expect(within(panel).getByTestId('order-detail-total').textContent).toContain('38.70');
    expect(within(panel).getByTestId('order-timeline').textContent).toContain('Draft');
    await userEvent.click(within(panel).getByTestId('order-confirm'));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm order' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === `/api/v1/orders/${DRAFT.id}/confirm`),
      ).toBe(true),
    );
  });

  it('cancels with a reason', async () => {
    signedInAs('owner');
    const calls = api();
    render(<OrdersPage />);
    await userEvent.click((await screen.findAllByTestId('order-open'))[0]!);
    const panel = await screen.findByTestId('order-detail');
    await userEvent.click(await within(panel).findByTestId('order-cancel'));
    await userEvent.type(await screen.findByTestId('order-cancel-reason'), 'Customer called');
    const dialogs = await screen.findAllByRole('dialog');
    await userEvent.click(within(dialogs[dialogs.length - 1]!).getByTestId('form-save'));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === `/api/v1/orders/${DRAFT.id}/cancel`)
          ?.body,
      ).toEqual({ reason: 'Customer called' }),
    );
  });

  it('offers no new order, edit, confirm or cancel to read-only staff', async () => {
    signedInAs('staff');
    api();
    render(<OrdersPage />);
    await userEvent.click((await screen.findAllByTestId('order-open'))[0]!);
    const panel = await screen.findByTestId('order-detail');
    await within(panel).findByText('Rice 5 kg');
    expect(screen.queryByTestId('order-create')).toBeNull();
    expect(within(panel).queryByTestId('order-actions')).toBeNull();
  });
});

describe('Customers (/orders/customers)', () => {
  it('lists customers and adds one', async () => {
    signedInAs('owner');
    const calls = api();
    render(<CustomersPage />);
    const rows = await screen.findAllByTestId('customer-row');
    expect(rows.map((r) => r.dataset.name)).toEqual(['Lotus Mart']);
    await userEvent.click(screen.getByTestId('customer-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('customer-name'), 'New Shop');
    await userEvent.type(within(dialog).getByTestId('customer-email'), 'not-an-email');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(await within(dialog).findByText('Enter a valid email address.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByTestId('customer-email'));
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === '/api/v1/orders/customers')?.body,
      ).toEqual({ name: 'New Shop' }),
    );
  });

  it('is read-only for staff', async () => {
    signedInAs('staff');
    api();
    render(<CustomersPage />);
    await screen.findAllByTestId('customer-row');
    expect(screen.queryByTestId('customer-create')).toBeNull();
    expect(screen.queryByTestId('customer-edit')).toBeNull();
  });
});
