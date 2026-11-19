// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { DeliveriesPage } from '../orders/deliveries-page';
import { BrandProvider } from '../theme-provider';
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
  requestedByName: 'Sam Example',
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

/** A stock level at the main warehouse (what picking checks against). */
const level = (itemId: string, quantity: string) => ({
  warehouseId: MAIN.id,
  itemId,
  itemName: '',
  unit: 'pc',
  quantity,
  averageCost: '1.0000',
  value: '1.00',
  low: false,
});
/** Plenty of rice and oil unless a test says otherwise. */
const PLENTY = [level(id(51), '10.000'), level(id(52), '10.000')];

/** The request cart's setup (ADR 0053): source warehouses and the branches to request for. */
const setup = {
  stock: PLENTY,
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
    if (input.startsWith('/api/v1/inventory/stock'))
      return Promise.resolve(Response.json({ data: setup.stock }));
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

/** AsiaMight's menu layout (ADR 0044), where a branch has its own pages (ADR 0059). */
const operations = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'AsiaMight', logoUrl: null, navLayout: 'operations' }}>
    {children}
  </BrandProvider>
);

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
    const rice = (await screen.findAllByTestId('request-item'))[0]!;
    await userEvent.click(within(rice).getByTestId('request-add'));
    await userEvent.click(screen.getByTestId('request-cart-open'));
    const cart = await screen.findByTestId('request-cart');
    expect(cart.textContent).toContain('has no store yet');
    await userEvent.click(within(cart).getByTestId('request-submit'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toEqual({
        fromWarehouseId: MAIN.id,
        toLocationId: BRANCH.locationId,
        lines: [{ itemId: id(51), quantity: '1' }],
      }),
    );
  });

  it('asks for no more than the main warehouse has, and lays out the cart', async () => {
    signedInAs('branch');
    const calls = api(request('submitted'));
    render(<RequestStockPage />);
    const [rice, oil] = await screen.findAllByTestId('request-item');
    // Nothing there, nothing to add.
    expect(within(oil!).getByTestId('request-add')).toHaveProperty('disabled', true);
    // 10 there: "+" stops at 10.
    await userEvent.click(within(rice!).getByTestId('request-add'));
    const quantity = within(rice!).getByTestId<HTMLInputElement>('request-quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '10');
    expect(within(rice!).getByTestId('request-more')).toHaveProperty('disabled', true);
    // Typed beyond it: named, and not sent.
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '12');
    expect(within(rice!).getByTestId('request-item-available').textContent).toBe(
      'Only 10 pc available',
    );
    await userEvent.click(screen.getByTestId('request-cart-open'));
    const cart = await screen.findByTestId('request-cart');
    // The cart's title and route show (not only for screen readers).
    expect(within(cart).getByText('Your request')).toBeTruthy();
    await userEvent.click(within(cart).getByTestId('request-submit'));
    expect(
      within(cart).getByText(/More than the main warehouse has: Rice \(10 pc available\)/),
    ).toBeTruthy();
    expect(posts(calls)).toEqual([]);
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

describe('Request cart without a branch (ADR 0059)', () => {
  afterEach(() => {
    setup.destinations = [
      {
        locationId: BRANCH.locationId,
        locationName: BRANCH.locationName,
        warehouseId: BRANCH.id,
        warehouseName: BRANCH.name,
      },
    ];
  });

  it('shows someone who sets up staff how to set one up, and tells a branch whom to ask', async () => {
    setup.destinations = [];
    // Asks for goods (no approving) and manages staff.
    mockState.session = sessionFixture({
      activePermissions: ['orders.requests.read', 'orders.requests.create', 'platform.users.edit'],
      activeFeatures: ['inventory', 'catalog', 'orders'],
    });
    api(request('submitted'));
    render(<RequestStockPage />);
    const setupCard = await screen.findByTestId('request-no-branch-setup');
    const links = within(setupCard).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/branches', '/staff']);
    cleanup();

    signedInAs('branch');
    api(request('submitted'));
    render(<RequestStockPage />, { wrapper: operations });
    expect(await screen.findByText(/tick your branch for you in Manage Staff/)).toBeTruthy();
    expect(screen.queryByTestId('request-no-branch-setup')).toBeNull();
    // A branch's way back is its Order History.
    expect(screen.getByRole('link', { name: 'Order History' }).getAttribute('href')).toBe(
      '/requests',
    );
  });
});

describe('Stock Requests', () => {
  it('lets the owner approve with changed quantities, against what is on hand', async () => {
    signedInAs('owner');
    // 10 rice on hand, only 4 oil of the 6 asked for.
    setup.stock = [level(id(51), '10.000'), level(id(52), '4.000')];
    const calls = api(request('submitted'));
    render(<RequestsPage />);
    await userEvent.click(await screen.findByTestId('request-row'));
    const panel = await screen.findByTestId('request-panel');
    await userEvent.click(await within(panel).findByTestId('request-approve'));
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
    // Requested, on hand and what to send, under their headings; a short line starts at what is there.
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByTestId('request-approve-available')
          .map((cell) => cell.textContent),
      ).toEqual(['10 pc', '4 pc']),
    );
    expect(within(dialog).getByRole('columnheader', { name: 'On hand' })).toBeTruthy();
    expect(within(dialog).getByRole('columnheader', { name: 'To send' })).toBeTruthy();
    expect(within(dialog).getByTestId('request-approve-short').textContent).toBe('Short 2 pc');
    const inputs = within(dialog).getAllByTestId<HTMLInputElement>('request-approve-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['6', '4']);
    setup.stock = PLENTY;
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

describe('A branch’s Order History and Delivery Tracking (ADR 0059)', () => {
  it('lists the branch’s requests as a table, searched by number and filtered by stage', async () => {
    signedInAs('branch');
    const calls = api(request('approved'));
    render(<RequestsPage />, { wrapper: operations });
    expect(await screen.findByRole('heading', { name: 'Order History' })).toBeTruthy();
    const row = await screen.findByTestId('request-table-row');
    expect(row.textContent).toContain('SRQ-2026-000047');
    expect(row.textContent).toContain('Kurfürstenstraße');
    expect(row.textContent).toContain('TRF-2026-000047');
    expect(within(row).getByTestId('request-requested-by').textContent).toBe('Sam Example');
    // A branch opens on all of its requests; an owner on what waits for approval.
    expect(screen.getByTestId<HTMLSelectElement>('requests-status').value).toBe('all');
    expect(calls.some((c) => c.path === '/api/v1/stock-requests')).toBe(true);

    await userEvent.type(screen.getByTestId('requests-search'), 'TRF-2026-0000');
    expect(screen.getByTestId('request-table-row')).toBeTruthy();
    await userEvent.type(screen.getByTestId('requests-search'), '99');
    expect(screen.queryByTestId('request-table-row')).toBeNull();
    expect(screen.getByTestId('requests-empty').textContent).toContain('TRF-2026-000099');

    await userEvent.selectOptions(screen.getByTestId('requests-status'), 'done');
    await waitFor(() =>
      expect(calls.at(-1)?.path).toBe(
        '/api/v1/stock-requests?status=received%2Crejected%2Ccancelled',
      ),
    );
  });

  it('gives owners Order History with the approval queue, and no request cart', async () => {
    signedInAs('owner');
    api(request('submitted'));
    render(<RequestsPage />, { wrapper: operations });
    expect(await screen.findByRole('heading', { name: 'Order History' })).toBeTruthy();
    expect(screen.getByTestId<HTMLSelectElement>('requests-status').value).toBe('open');
    // Branches send requests; who approves them doesn't.
    expect(screen.queryByTestId('requests-new')).toBeNull();
    cleanup();

    signedInAs('owner');
    api(request('submitted'));
    render(<RequestStockPage />, { wrapper: operations });
    expect(await screen.findByTestId('request-branch-only')).toBeTruthy();
    expect(screen.queryByTestId('request-item')).toBeNull();
  });

  it('follows the branch’s requests to its door and links to confirming receipt', async () => {
    signedInAs('branch');
    const calls = api(request('in_transit', { driverUserId: id(60), driverName: 'Ali' }));
    render(<DeliveriesPage />);
    const card = await screen.findByTestId('tracking-card');
    expect(card.textContent).toContain('Driver: Ali');
    const steps = within(card).getByTestId('tracking-steps');
    const done = [...steps.querySelectorAll('li')].map((li) => li.getAttribute('data-done'));
    expect(done).toEqual(['true', 'true', 'true', 'true', 'false']);
    expect(within(card).getByTestId('tracking-receive').getAttribute('href')).toBe(
      `/requests?open=${id(10)}`,
    );
    expect(
      calls.some((c) =>
        c.path.startsWith('/api/v1/stock-requests?status=approved%2Cpicking%2Cpacked'),
      ),
    ).toBe(true);
    // Not the sales-order board: a branch has neither orders.delivery.use nor assign.
    expect(screen.queryByTestId('transfers-picking')).toBeNull();
  });
});

describe('Transfers on the Picking page (warehouse)', () => {
  afterEach(() => {
    setup.stock = PLENTY;
  });

  it('shows what is in stock, starts a short line at what is there and names too much', async () => {
    signedInAs('warehouse');
    // Rice: 3 on the shelf of 5 approved; no oil at all.
    setup.stock = [level(id(51), '3.000')];
    const calls = api(
      request('approved', {
        lines: [
          line(1, 'Rice', { approvedQuantity: '5.000' }),
          line(2, 'Oil', { approvedQuantity: '2.000' }),
        ],
      }),
    );
    render(<TransfersPicking organizationId={mockState.session!.activeOrganizationId} />);
    const row = await screen.findByTestId('transfer-row');
    await userEvent.click(await within(row).findByTestId('transfer-pack'));
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByTestId('transfer-pack-available')
          .map((cell) => cell.textContent),
      ).toEqual(['3 pc', '0 pc']),
    );
    const inputs = within(dialog).getAllByTestId<HTMLInputElement>('transfer-pack-quantity');
    expect(inputs.map((i) => i.value)).toEqual(['3', '0']);
    expect(
      within(dialog)
        .getAllByTestId('transfer-pack-short')
        .map((badge) => badge.textContent),
    ).toEqual(['Short 2 pc', 'Short 2 pc']);
    expect(within(dialog).getByTestId('transfer-pack-shortage').textContent).toContain(
      'Rice (3 pc in stock), Oil (0 pc in stock)',
    );

    // More than the shelf has is named before packing.
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, '4');
    expect(within(dialog).getByTestId('transfer-pack-beyond').textContent).toContain(
      'Rice (3 pc in stock)',
    );
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, '3');
    expect(within(dialog).queryByTestId('transfer-pack-beyond')).toBeNull();
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toEqual({
        lines: [
          { lineId: id(41), quantity: '3' },
          { lineId: id(42), quantity: '0' },
        ],
      }),
    );
  });

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
