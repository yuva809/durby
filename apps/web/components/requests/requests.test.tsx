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
import { RequestPicking } from './request-picking';
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
/** What the warehouse has, by category (the availability the picking page reads). */
const AVAILABILITY = [
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
];
/** Not on the request: added at picking, from its category. */
const SALT = {
  itemId: id(53),
  itemName: 'Salt',
  sku: null,
  unit: 'pc',
  available: '7.000',
  categoryId: id(70),
  categoryName: 'Dry goods',
};

/** The request cart's setup (ADR 0053): source warehouses and the branches to request for. */
const setup = {
  stock: PLENTY,
  warehouses: [MAIN, BRANCH] as Record<string, unknown>[],
  availability: AVAILABILITY as Record<string, unknown>[],
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
    if (input.startsWith('/api/v1/stock-requests/availability/'))
      return Promise.resolve(Response.json({ data: setup.availability }));
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
      'RRiceR-110 pc available at the warehouseRequest',
      // Out of stock may still be asked for: it is sent once it is in.
      'OOilOut of stockRequest',
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
    expect(screen.getByTestId('request-sent-oc').getAttribute('href')).toBe(
      `/requests/${id(10)}/oc`,
    );
    expect(screen.queryByTestId('request-cart-count')).toBeNull();
  });

  it('opens the request to send straight away from the shop\'s "View request" (item 5)', async () => {
    signedInAs('branch');
    mockState.search = 'cart=1';
    api(request('submitted'));
    render(<RequestStockPage />);
    expect(await screen.findByTestId('request-cart')).toBeTruthy();
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

  it('asks for more than the main warehouse has, saying the rest follows, and lays out the cart', async () => {
    signedInAs('branch');
    const calls = api(request('submitted'));
    render(<RequestStockPage />);
    const [rice, oil] = await screen.findAllByTestId('request-item');
    // Nothing there: it may still be asked for.
    await userEvent.click(within(oil!).getByTestId('request-add'));
    // 10 there: typed beyond it, named, and still sent.
    await userEvent.click(within(rice!).getByTestId('request-add'));
    const quantity = within(rice!).getByTestId<HTMLInputElement>('request-quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '12');
    expect(within(rice!).getByTestId('request-more')).toHaveProperty('disabled', false);
    expect(within(rice!).getByTestId('request-item-available').textContent).toBe(
      'Only 10 pc at the warehouse: the rest follows once it is in',
    );
    await userEvent.click(screen.getByTestId('request-cart-open'));
    const cart = await screen.findByTestId('request-cart');
    // The cart's title and route show (not only for screen readers).
    expect(within(cart).getByText('Your request')).toBeTruthy();
    expect(within(cart).getByTestId('request-cart-beyond')).toBeTruthy();
    expect(within(cart).getByText('None at the warehouse right now')).toBeTruthy();
    await userEvent.click(within(cart).getByTestId('request-submit'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toMatchObject({
        lines: [
          { itemId: id(52), quantity: '1' },
          { itemId: id(51), quantity: '12' },
        ],
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
    expect(within(row).getByTestId('request-requested-by').textContent).toBe('Sam Example');
    // Its documents (ADR 0064): the order confirmation now, the delivery challan once packed.
    expect(within(row).getByTestId('request-oc-link').getAttribute('href')).toBe(
      `/requests/${id(10)}/oc`,
    );
    expect(within(row).getByTestId('request-oc-link').textContent).toBe('OC SRQ-2026-000047');
    expect(within(row).queryByTestId('request-dc-link')).toBeNull();
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
    // Every stage, from sent to received (item 11).
    expect(screen.getByTestId<HTMLSelectElement>('requests-status').value).toBe('all');
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

describe('Delivery Tracking for owners (operations menu, item 6)', () => {
  it("shows every branch's deliveries, named by branch, without confirming receipt", async () => {
    signedInAs('owner');
    api(request('in_transit', { driverUserId: id(60), driverName: 'Ali' }));
    render(<DeliveriesPage />, { wrapper: operations });
    const board = await screen.findByTestId('branch-deliveries-overview');
    expect(within(board).getByRole('heading', { level: 1 }).textContent).toBe(
      'Deliveries to branches',
    );
    const card = await within(board).findByTestId('tracking-card');
    expect(within(card).getByTestId('tracking-branch').textContent).toBe('To Kurfürstenstraße');
    expect(within(card).queryByTestId('tracking-receive')).toBeNull();
    // The sales orders' board below has its own title.
    expect(screen.getByRole('heading', { name: 'Sales order deliveries' })).toBeTruthy();
  });
});

describe('Transfers on the Picking page (warehouse)', () => {
  afterEach(() => {
    setup.stock = PLENTY;
  });

  it('opens the picking page of a transfer', async () => {
    signedInAs('warehouse');
    api(request('approved', { lines: [line(1, 'Rice', { approvedQuantity: '5.000' })] }));
    render(<TransfersPicking organizationId={mockState.session!.activeOrganizationId} />);
    const row = await screen.findByTestId('transfer-row');
    await userEvent.click(await within(row).findByTestId('transfer-pack'));
    expect(mockState.router.push).toHaveBeenCalledWith(`/picking/${id(10)}`);
  });
});

describe('Picking a transfer (/picking/:id, item 9)', () => {
  afterEach(() => {
    setup.stock = PLENTY;
    setup.availability = AVAILABILITY;
  });

  it('shows requested, picked and packed per line; picked may go above what was asked', async () => {
    signedInAs('warehouse');
    const calls = api(
      request('approved', {
        lines: [
          line(1, 'Rice', { approvedQuantity: '5.000' }),
          line(2, 'Oil', { approvedQuantity: '2.000' }),
        ],
      }),
    );
    render(<RequestPicking requestId={id(10)} />);
    const rows = await screen.findAllByTestId('pick-row');
    expect(rows).toHaveLength(2);
    const [rice, oil] = rows;
    expect(within(rice!).getByTestId<HTMLInputElement>('pick-quantity').value).toBe('5');
    // Nothing of the oil is on the shelf, so nothing is picked for it.
    expect(within(oil!).getByTestId<HTMLInputElement>('pick-quantity').value).toBe('0');
    expect(oil!.textContent).toContain('on shelf');

    await userEvent.clear(within(rice!).getByTestId('pick-quantity'));
    await userEvent.type(within(rice!).getByTestId('pick-quantity'), '7');
    await userEvent.click(within(rice!).getByTestId('pick-packed'));
    expect(screen.getByTestId('pick-progress').textContent).toContain('1 of 2');
    await userEvent.click(screen.getByTestId('pick-submit'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toEqual({
        lines: [
          { lineId: id(41), quantity: '7' },
          { lineId: id(42), quantity: '0' },
        ],
      }),
    );
  });

  it('adds an item nobody asked for from its category, and sends it with the packing (item 9)', async () => {
    signedInAs('warehouse');
    setup.availability = [...AVAILABILITY, SALT] as Record<string, unknown>[];
    const calls = api(
      request('approved', { lines: [line(1, 'Rice', { approvedQuantity: '5.000' })] }),
    );
    render(<RequestPicking requestId={id(10)} />);
    await userEvent.click(await screen.findByTestId('pick-add-item'));
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
    const dry = within(dialog)
      .getAllByTestId('pick-category')
      .find((tile) => tile.textContent?.includes('Dry goods'));
    await userEvent.click(dry!);
    const saltRow = within(dialog)
      .getAllByTestId('pick-add-row')
      .find((r) => r.textContent?.includes('Salt'))!;
    await userEvent.type(within(saltRow).getByTestId('pick-add-quantity'), '2');
    await userEvent.click(within(saltRow).getByTestId('pick-add-line'));
    expect(within(saltRow).getByTestId('pick-in-shipment').textContent).toContain('2');
    expect(within(dialog).getByTestId('pick-cart-count').textContent).toContain('1');
    await userEvent.click(within(dialog).getByTestId('pick-add-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const extra = (await screen.findAllByTestId('pick-row')).find(
      (r) => r.getAttribute('data-extra') === 'true',
    )!;
    expect(extra.textContent).toContain('Salt');
    expect(within(extra).getByTestId<HTMLInputElement>('pick-quantity').value).toBe('2');
    // Rice may go above the 5 asked, up to what is on the shelf.
    const rice = (await screen.findAllByTestId('pick-row')).find((r) =>
      r.textContent?.includes('Rice'),
    )!;
    await userEvent.clear(within(rice).getByTestId('pick-quantity'));
    await userEvent.type(within(rice).getByTestId('pick-quantity'), '6');
    await userEvent.click(screen.getByTestId('pick-submit'));
    await waitFor(() =>
      expect(posts(calls)[0]?.body).toEqual({
        lines: [{ lineId: id(41), quantity: '6' }],
        extra: [{ itemId: id(53), quantity: '2' }],
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
