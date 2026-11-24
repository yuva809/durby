// @vitest-environment jsdom
import type { GuestCheck, Order } from '@durby/shared';
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { times } from '../../lib/pos/format';
import { forgetDeviceBillPrinters } from '../../lib/print/device-printer';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
import { FloorPage } from './floor-page';
import { OrderPage } from './order-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

const print = vi.fn();

/** The Android app's print object, or none (a browser: every other test). */
const app = vi.hoisted(() => ({
  printer: null as null | { print: ReturnType<typeof vi.fn> },
}));
vi.mock('../../lib/print/native', async (original) => ({
  ...(await original<typeof import('../../lib/print/native')>()),
  nativePrinter: () => app.printer,
}));
// jsdom has no canvas: the picture itself is tested in lib/print.
vi.mock('../../lib/print/bill-image', () => ({
  renderBillImage: vi.fn(() => Promise.resolve({ width: 576, height: 1, data: 'A'.repeat(96) })),
}));

/** The till names the product on the bill ("Powered by"). */
const Brand = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>{children}</BrandProvider>
);

beforeEach(() => {
  resetMocks();
  print.mockReset();
  window.print = print;
  app.printer = null;
  forgetDeviceBillPrinters();
});
afterEach(() => {
  cleanup();
  document.getElementById('print-root')?.remove();
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(1), name: 'Main street', brandId: id(2) };
/** Kitchen and bar both prepare (ADR 0031), unless a test says otherwise. */
const ON = { kitchen: true, bar: true };
const TABLE = {
  id: id(3),
  locationId: LOCATION.id,
  name: 'T1',
  seats: 4,
  area: null,
  shape: 'square',
  color: 'neutral',
  seatedAt: null,
  lastOrderAt: null,
};
const FOOD = { id: id(4), name: 'Food', sortOrder: 0, station: 'kitchen', archivedAt: null };
const product = (n: number, name: string, price: string, taxRate: string) => ({
  id: id(10 + n),
  categoryId: FOOD.id,
  name,
  menuNumber: null,
  description: null,
  price,
  taxRate,
  sortOrder: 0,
  archivedAt: null,
});
const SOUP = product(1, 'Soup', '6.90', '7.00');
const COLA = product(2, 'Cola', '3.80', '19.00');

const line = (
  n: number,
  ticketId: string,
  p: typeof SOUP,
  quantity: number,
  remaining: number,
) => ({
  id: id(30 + n),
  ticketId,
  productId: p.id,
  productName: p.name,
  unitPrice: p.price,
  taxRate: p.taxRate,
  quantity,
  note: null,
  voidsLineId: null,
  remaining,
  billedQuantity: 0,
  seat: null,
  total: times(p.price, quantity),
  createdAt: '2026-10-27T12:00:00.000Z',
});

const ORDER: Order = {
  id: id(20),
  number: 'ORD-2026-000001',
  tableId: TABLE.id,
  tableName: 'T1',
  locationId: LOCATION.id,
  status: 'open',
  openedAt: '2026-10-27T12:00:00.000Z',
  closedAt: null,
  covers: null,
  itemCount: 2,
  gross: '13.80',
  readyCount: 0,
  tickets: [
    {
      id: id(21),
      sequence: 1,
      kind: 'order',
      station: 'kitchen',
      status: 'new',
      direct: false,
      createdAt: '2026-10-27T12:00:00.000Z',
      lines: [line(1, id(21), SOUP, 2, 2)],
    },
  ],
  totals: {
    itemCount: 2,
    gross: '13.80',
    byTaxRate: [{ taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' }],
  },
  waiterName: 'Priya',
  bills: [],
  discounts: [],
  unbilled: '13.80',
};

function signedInAs(role: SystemRole, without: string[] = []) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)].filter((key) => !without.includes(key)),
    activeFeatures: ['catalog', 'pos'],
  });
}

/** Answers by method and path; records the writes. */
function api(answers: Record<string, () => Response>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    }
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
  return writes;
}

/** EUR in English, so amounts are formatted as in the real app. */
const SETTINGS = {
  'GET /api/v1/settings': () =>
    Response.json({
      data: [
        { key: 'locale', value: 'en', source: 'default', dataBound: false },
        { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
      ],
    }),
};

const menu = {
  ...SETTINGS,
  'GET /api/v1/catalog/categories': () => Response.json({ data: [FOOD] }),
  'GET /api/v1/catalog/products': () => Response.json({ data: [SOUP, COLA] }),
};

/** The guest check a bill of the whole order prints (docs/modules/pos.md → Step 4). */
const CHECK_ID = id(70);
function checkOf(order: Order): GuestCheck {
  const items = order.tickets.flatMap((x) => x.lines.filter((l) => l.remaining > 0));
  return {
    id: CHECK_ID,
    number: 'CHK-2026-000001',
    billId: id(71),
    locationId: order.locationId,
    shareIndex: null,
    shareCount: null,
    createdAt: '2026-10-27T12:30:00.000Z',
    cancelled: false,
    cancelledAt: null,
    orders: [
      {
        id: order.id,
        number: order.number,
        tableId: order.tableId,
        tableName: order.tableName,
        covers: order.covers,
        waiterName: order.waiterName,
      },
    ],
    lines: items.map((l) => ({
      kind: 'item' as const,
      name: l.productName,
      quantity: l.remaining,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      total: times(l.unitPrice, l.remaining),
    })),
    totals: order.totals,
  };
}

const withOrder = (order: Order | null) => ({
  ...menu,
  [`GET /api/v1/pos/tables/${TABLE.id}/order`]: () =>
    Response.json({ table: TABLE, order, processing: ON }),
  ...(order && {
    'POST /api/v1/pos/bills': () =>
      Response.json(
        {
          id: id(71),
          kind: 'single',
          shareCount: null,
          createdAt: '2026-10-27T12:30:00.000Z',
          cancelled: false,
          checks: [
            {
              id: CHECK_ID,
              number: 'CHK-2026-000001',
              shareIndex: null,
              gross: order.totals.gross,
            },
          ],
          locationId: order.locationId,
          orderIds: [order.id],
          gross: order.totals.gross,
        },
        { status: 201 },
      ),
    [`GET /api/v1/pos/checks/${CHECK_ID}`]: () => Response.json(checkOf(order)),
  }),
});

describe('FloorPage', () => {
  const floor = () =>
    api({
      ...SETTINGS,
      'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            { ...TABLE, order: { ...ORDER, tickets: undefined, totals: undefined } },
            { ...TABLE, id: id(5), name: 'T2', order: null },
            { ...TABLE, id: id(6), name: 'Terrace 1', seats: 2, area: 'Terrace', order: null },
          ],
        }),
    });

  it('shows free and open tables by area, each linking to its order screen', async () => {
    signedInAs('waiter');
    floor();
    render(<FloorPage />);
    const tiles = await screen.findAllByTestId('floor-table');
    expect(tiles.map((t) => [t.dataset.name, t.dataset.state])).toEqual([
      ['T1', 'open'],
      ['T2', 'free'],
      ['Terrace 1', 'free'],
    ]);
    expect(screen.getByTestId('floor-summary').textContent).toBe('1 open · 2 free');
    expect(
      screen.getAllByTestId('floor-area').map((a) => a.querySelector('h2')?.textContent),
    ).toEqual(['Dining room', 'Terrace']);
    expect(await within(tiles[0]!).findByText('€13.80')).toBeTruthy();
    expect(within(tiles[0]!).getByText('ORD-2026-000001')).toBeTruthy();
    expect(within(tiles[1]!).getByText('4 seats')).toBeTruthy();
    expect(within(tiles[0]!).getByRole('link').getAttribute('href')).toBe(`/service/${TABLE.id}`);
  });

  it('filters open and free tables', async () => {
    signedInAs('waiter');
    floor();
    render(<FloorPage />);
    await screen.findAllByTestId('floor-table');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getAllByTestId('floor-table').map((t) => t.dataset.name)).toEqual(['T1']);
    await userEvent.click(screen.getByRole('button', { name: 'Free' }));
    expect(screen.getAllByTestId('floor-table').map((t) => t.dataset.name)).toEqual([
      'T2',
      'Terrace 1',
    ]);
  });

  it('shows "no access" to Staff', () => {
    signedInAs('staff');
    render(<FloorPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});

describe('FloorPage ready', () => {
  it('marks a table whose food or drinks are ready', async () => {
    signedInAs('waiter');
    api({
      ...SETTINGS,
      'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            { ...TABLE, order: { ...ORDER, tickets: undefined, totals: undefined, readyCount: 2 } },
            {
              ...TABLE,
              id: id(5),
              name: 'T2',
              order: {
                ...ORDER,
                id: id(25),
                tableId: id(5),
                tickets: undefined,
                totals: undefined,
              },
            },
          ],
        }),
    });
    render(<FloorPage />);
    const tiles = await screen.findAllByTestId('floor-table');
    expect(within(tiles[0]!).getByTestId('floor-ready').textContent).toBe('Ready to serve: 2');
    expect(within(tiles[1]!).queryByTestId('floor-ready')).toBeNull();
  });

  it('shows how long a table has been seated and since its last order (ADR 0069)', async () => {
    signedInAs('waiter');
    const now = Date.now();
    const seated = new Date(now - 42 * 60_000).toISOString();
    const last = new Date(now - 5 * 60_000).toISOString();
    api({
      ...SETTINGS,
      'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            {
              ...TABLE,
              seatedAt: seated,
              lastOrderAt: last,
              order: { ...ORDER, openedAt: seated, tickets: undefined, totals: undefined },
            },
            { ...TABLE, id: id(5), name: 'T2', seatedAt: null, lastOrderAt: null, order: null },
          ],
        }),
    });
    render(<FloorPage />);
    const [occupied, free] = await screen.findAllByTestId('floor-table');
    expect(within(occupied!).getByTestId('floor-seated').textContent).toBe('Seated 42 min');
    expect(within(occupied!).getByTestId('floor-last-order').textContent).toBe(
      'Last order 5 min ago',
    );
    expect(within(free!).queryByTestId('floor-seated')).toBeNull();
    expect(within(free!).queryByTestId('floor-last-order')).toBeNull();
  });
});

describe('OrderPage (till)', () => {
  const tile = async (name: string) =>
    (await screen.findAllByTestId('menu-product')).find((b) => b.dataset.name === name)!;
  const cartLine = (name: string) =>
    screen.getAllByTestId('cart-line').find((l) => l.dataset.name === name)!;

  it('builds the new items, sends them to the kitchen and prints the ticket', async () => {
    signedInAs('waiter');
    const sent: Order = {
      ...ORDER,
      tickets: [
        {
          id: id(22),
          sequence: 1,
          kind: 'order',
          station: 'kitchen',
          status: 'new',
          direct: false,
          createdAt: '2026-10-27T12:00:00.000Z',
          lines: [line(2, id(22), SOUP, 2, 2), { ...line(3, id(22), COLA, 1, 1), note: 'no ice' }],
        },
      ],
    };
    const writes = api({
      ...withOrder(null),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () =>
        Response.json({ order: sent, ticketId: id(22), ticketIds: [id(22)] }, { status: 201 }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    expect(within(await screen.findByTestId('table-bar')).getByText('T1')).toBeTruthy();
    expect(screen.queryByTestId('send-to-kitchen')).toBeNull();

    // The category rail carries product counts.
    const rail = await screen.findByTestId('category-chips');
    expect(
      within(rail)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All categories2', 'Food2']);

    await userEvent.click(await tile('Soup'));
    await userEvent.click(await tile('Soup'));
    await userEvent.click(await tile('Cola'));
    expect(within(await tile('Soup')).getByTestId('menu-count').textContent).toBe('2');
    expect(screen.getAllByTestId('cart-line').map((l) => l.dataset.name)).toEqual(['Soup', 'Cola']);

    // Quantity and a note inline on the line.
    await userEvent.click(within(cartLine('Cola')).getByRole('button', { name: 'Add note' }));
    await userEvent.type(screen.getByLabelText('Note for Cola'), 'no ice');
    await userEvent.click(screen.getByRole('button', { name: 'One more Cola' }));
    await userEvent.click(screen.getByRole('button', { name: 'One less Cola' }));
    expect(within(cartLine('Cola')).getByTestId('cart-quantity').textContent).toBe('1');
    expect(screen.getByTestId('cart-total').textContent).toBe('€17.60');
    expect(screen.getByTestId('send-to-kitchen').textContent).toBe('Send 3 to kitchen · €17.60');

    await userEvent.click(screen.getByTestId('send-to-kitchen'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/pos/tables/${TABLE.id}/tickets`,
        body: {
          lines: [
            { productId: SOUP.id, quantity: 2, note: '' },
            { productId: COLA.id, quantity: 1, note: 'no ice' },
          ],
        },
      },
    ]);
    expect(await screen.findByText('Sent: ticket 1 (Kitchen).')).toBeTruthy();
    // The ticket is in the print-only root: items and notes, no prices.
    const ticket = within(document.getElementById('print-root')!).getByTestId('kitchen-ticket');
    // Like a kitchen printer's slip: dine in, organization and time, table, # order, "New" items.
    expect(within(ticket).getByText('Dine in')).toBeTruthy();
    expect(within(ticket).getByText(/^Demo Bistro : /)).toBeTruthy();
    expect(within(ticket).getByTestId('kitchen-ticket-table').textContent).toBe('Table T1');
    expect(within(ticket).getByText(/^# .+ · Ticket 1$/)).toBeTruthy();
    expect(within(ticket).getByText('New')).toBeTruthy();
    expect(within(ticket).getByText('Soup').closest('li')!.textContent).toBe('2Soup');
    expect(within(ticket).getByText('no ice')).toBeTruthy();
    expect(within(ticket).queryByText(/13\.80/)).toBeNull();
  });

  // ADR 0025: drinks go to the bar, as a print job of their own.
  it('adds a dish by its menu number with Enter and names the stations on the send button', async () => {
    signedInAs('waiter');
    const DRINKS = { id: id(5), name: 'Drinks', sortOrder: 1, station: 'bar', archivedAt: null };
    api({
      ...withOrder(null),
      'GET /api/v1/catalog/categories': () => Response.json({ data: [FOOD, DRINKS] }),
      'GET /api/v1/catalog/products': () =>
        Response.json({
          data: [
            { ...SOUP, menuNumber: '12' },
            { ...COLA, categoryId: DRINKS.id, menuNumber: '40' },
          ],
        }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    // The number is on the tile.
    expect((await tile('Soup')).dataset.number).toBe('12');
    const search = screen.getByTestId('menu-search');
    await userEvent.type(search, '40{Enter}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('menu-added').textContent).toBe('Cola added.');
    expect(screen.getByTestId('send-to-kitchen').textContent).toBe('Send 1 to bar · €3.80');
    await userEvent.type(search, '12');
    expect(within(screen.getByTestId('menu-exact')).getByTestId('menu-product').dataset.name).toBe(
      'Soup',
    );
    await userEvent.type(search, '{Enter}');
    await userEvent.type(search, '12{Enter}');
    expect(screen.getAllByTestId('cart-line').map((l) => l.dataset.name)).toEqual(['Cola', 'Soup']);
    expect(screen.getByTestId('send-to-kitchen').textContent).toBe(
      'Send 3 to kitchen & bar · €17.60',
    );
    // An unknown number adds nothing.
    await userEvent.type(search, '99{Enter}');
    expect(screen.getAllByTestId('cart-line')).toHaveLength(2);
  });

  it("shows the price the table's location charges now, with the time rule's name", async () => {
    signedInAs('waiter');
    const asked: string[] = [];
    api({
      ...withOrder(null),
      'GET /api/v1/catalog/prices': () => {
        asked.push(TABLE.locationId);
        return Response.json({
          locationId: TABLE.locationId,
          at: '2026-11-06T17:00:00.000Z',
          data: [
            { productId: SOUP.id, price: '6.90', ruleId: null, ruleName: null, timed: false },
            {
              productId: COLA.id,
              price: '3.04',
              ruleId: id(60),
              ruleName: 'Happy hour',
              timed: true,
            },
          ],
        });
      },
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    const cola = await tile('Cola');
    await waitFor(() => expect(within(cola).getByTestId('menu-price').textContent).toBe('€3.04'));
    expect(within(cola).getByTestId('menu-price-tag').textContent).toBe('Happy hour');
    expect(within(await tile('Soup')).queryByTestId('menu-price-tag')).toBeNull();
    expect(asked[0]).toBe(TABLE.locationId);
    await userEvent.click(cola);
    expect(screen.getByTestId('cart-total').textContent).toBe('€3.04');
  });

  it('prints the kitchen and the bar ticket of one send as two print jobs', async () => {
    signedInAs('waiter');
    const ticket = (n: number, station: 'kitchen' | 'bar', l: ReturnType<typeof line>) => ({
      id: id(n),
      sequence: n - 21,
      kind: 'order' as const,
      station,
      status: 'new' as const,
      direct: false,
      createdAt: '2026-10-27T12:00:00.000Z',
      lines: [l],
    });
    const sent: Order = {
      ...ORDER,
      tickets: [
        ticket(22, 'kitchen', line(2, id(22), SOUP, 1, 1)),
        ticket(23, 'bar', line(3, id(23), COLA, 1, 1)),
      ],
    };
    let current: Order | null = null;
    api({
      ...menu,
      [`GET /api/v1/pos/tables/${TABLE.id}/order`]: () =>
        Response.json({ table: TABLE, order: current, processing: ON }),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () => {
        current = sent;
        return Response.json(
          { order: sent, ticketId: id(22), ticketIds: [id(22), id(23)] },
          { status: 201 },
        );
      },
    });
    // What each print job shows: the tickets not hidden at that moment.
    const jobs: string[][] = [];
    print.mockImplementation(() =>
      jobs.push(
        [...document.querySelectorAll<HTMLElement>('#print-root [data-print-part]')]
          .filter((part) => !part.hidden)
          .map((part) => part.querySelector('[data-station]')!.getAttribute('data-station')!),
      ),
    );
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await tile('Soup'));
    await userEvent.click(await tile('Cola'));
    await userEvent.click(screen.getByTestId('send-to-kitchen'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(jobs).toEqual([['kitchen'], ['bar']]);
    expect(await screen.findByText('Sent: ticket 1 (Kitchen), 2 (Bar).')).toBeTruthy();
    const printed = within(document.getElementById('print-root')!).getAllByTestId('kitchen-ticket');
    expect(printed.map((t) => t.hidden || t.closest('[hidden]') !== null)).toEqual([false, false]);
    expect(within(printed[0]!).getByText('Dine in')).toBeTruthy();
    expect(within(printed[1]!).getByText('BAR')).toBeTruthy();
    expect(within(printed[1]!).getByText('Cola')).toBeTruthy();
    expect(within(printed[1]!).queryByText('Soup')).toBeNull();
    // The ticket log names each ticket's station.
    await waitFor(() => expect(screen.getAllByTestId('ticket-station')).toHaveLength(2));
    expect(screen.getAllByTestId('ticket-station').map((b) => b.textContent)).toEqual([
      'Kitchen',
      'Bar',
    ]);
  });

  it('adds straight to the bill where the bar is off: prints only the kitchen ticket (ADR 0031)', async () => {
    signedInAs('waiter');
    const ticket = (
      n: number,
      station: 'kitchen' | 'bar',
      direct: boolean,
      l: ReturnType<typeof line>,
    ) => ({
      id: id(n),
      sequence: n - 21,
      kind: 'order' as const,
      station,
      status: 'new' as const,
      direct,
      createdAt: '2026-10-27T12:00:00.000Z',
      lines: [l],
    });
    const sent: Order = {
      ...ORDER,
      tickets: [
        ticket(22, 'kitchen', false, line(2, id(22), SOUP, 1, 1)),
        ticket(23, 'bar', true, line(3, id(23), COLA, 1, 1)),
      ],
    };
    const DRINKS = { id: id(5), name: 'Drinks', sortOrder: 1, station: 'bar', archivedAt: null };
    let current: Order | null = null;
    api({
      ...menu,
      'GET /api/v1/catalog/categories': () => Response.json({ data: [FOOD, DRINKS] }),
      'GET /api/v1/catalog/products': () =>
        Response.json({ data: [SOUP, { ...COLA, categoryId: DRINKS.id }] }),
      [`GET /api/v1/pos/tables/${TABLE.id}/order`]: () =>
        Response.json({ table: TABLE, order: current, processing: { kitchen: true, bar: false } }),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () => {
        current = sent;
        return Response.json(
          { order: sent, ticketId: id(22), ticketIds: [id(22), id(23)] },
          { status: 201 },
        );
      },
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    // Drinks only: nothing goes to a station.
    await userEvent.click(await tile('Cola'));
    expect(screen.getByTestId('send-to-kitchen').textContent).toContain('Add 1 to bill');
    await userEvent.click(await tile('Soup'));
    expect(screen.getByTestId('send-to-kitchen').textContent).toContain('Send 2 to kitchen');
    await userEvent.click(screen.getByTestId('send-to-kitchen'));
    expect(await screen.findByText('Sent: ticket 1 (Kitchen), 2 (Bill).')).toBeTruthy();
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const printed = within(document.getElementById('print-root')!).getAllByTestId('kitchen-ticket');
    expect(printed).toHaveLength(1);
    expect(within(printed[0]!).getByText('Dine in')).toBeTruthy();
    // The ticket log says where the drink went.
    await waitFor(() => expect(screen.getAllByTestId('ticket-status')).toHaveLength(2));
    expect(screen.getAllByTestId('ticket-status').map((b) => b.textContent)).toEqual([
      'New',
      'Added to bill',
    ]);
  });

  // docs/modules/reservations.md → R0.5: guests at the table.
  describe('guests', () => {
    const guests = () => screen.findByTestId('guests');

    it('on a free table, sends the guests with the first items', async () => {
      signedInAs('waiter');
      const writes = api({
        ...withOrder(null),
        [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () =>
          Response.json(
            { order: { ...ORDER, covers: 2 }, ticketId: id(21), ticketIds: [id(21)] },
            { status: 201 },
          ),
      });
      render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
      const field = await guests();
      expect(within(field).getByTestId('guests-value').textContent).toBe('–');
      await userEvent.click(within(field).getByRole('button', { name: 'More guests' }));
      await userEvent.click(within(field).getByRole('button', { name: 'More guests' }));
      expect(within(field).getByTestId('guests-value').textContent).toBe('2');
      // Nothing to save yet: the guests go with the send.
      expect(within(field).queryByRole('button', { name: 'Save' })).toBeNull();
      await userEvent.click(await tile('Soup'));
      await userEvent.click(screen.getByTestId('send-to-kitchen'));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]?.body).toEqual({
        lines: [{ productId: SOUP.id, quantity: 1, note: '' }],
        covers: 2,
      });
    });

    it('on an open order, shows them and saves a change; fewer than one clears them', async () => {
      signedInAs('waiter');
      const writes = api({
        ...withOrder({ ...ORDER, covers: 3 }),
        [`PATCH /api/v1/pos/orders/${ORDER.id}`]: () => Response.json({ ...ORDER, covers: 4 }),
      });
      render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
      const field = await guests();
      expect(within(field).getByTestId('guests-value').textContent).toBe('3');
      expect(within(screen.getByTestId('table-bar')).getByText(/3 guests/)).toBeTruthy();
      await userEvent.click(within(field).getByRole('button', { name: 'More guests' }));
      await userEvent.click(within(field).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]).toEqual({
        method: 'PATCH',
        path: `/api/v1/pos/orders/${ORDER.id}`,
        body: { covers: 4 },
      });
    });

    it('steps down to empty and back up', async () => {
      signedInAs('waiter');
      api(withOrder({ ...ORDER, covers: 1 }));
      render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
      const field = await guests();
      await userEvent.click(within(field).getByRole('button', { name: 'Fewer guests' }));
      expect(within(field).getByTestId('guests-value').textContent).toBe('–');
      expect(
        within(field).getByRole<HTMLButtonElement>('button', { name: 'Fewer guests' }).disabled,
      ).toBe(true);
      expect(within(field).getByRole('button', { name: 'Save' })).toBeTruthy();
    });

    it('shows a cashier the guests in the header, without the field', async () => {
      signedInAs('cashier');
      api(withOrder({ ...ORDER, covers: 3 }));
      render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
      expect(
        await within(await screen.findByTestId('table-bar')).findByText(/3 guests/),
      ).toBeTruthy();
      expect(screen.queryByTestId('guests')).toBeNull();
    });
  });

  it('removes a new item at quantity zero, and clears all', async () => {
    signedInAs('waiter');
    api(withOrder(null));
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await tile('Soup'));
    await userEvent.click(await tile('Cola'));
    await userEvent.click(screen.getByRole('button', { name: 'One less Soup' }));
    expect(screen.getAllByTestId('cart-line').map((l) => l.dataset.name)).toEqual(['Cola']);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryAllByTestId('cart-line')).toEqual([]);
    expect(screen.queryByTestId('send-to-kitchen')).toBeNull();
  });

  it('combines sent items; without bill printing (a custom role) only the order prints, without amounts', async () => {
    signedInAs('waiter', ['pos.bills.print']);
    const twice: Order = {
      ...ORDER,
      tickets: [
        ...ORDER.tickets,
        {
          id: id(24),
          sequence: 2,
          kind: 'order',
          station: 'kitchen',
          status: 'new',
          direct: false,
          createdAt: '2026-10-27T12:10:00.000Z',
          lines: [line(5, id(24), SOUP, 1, 1)],
        },
      ],
      totals: {
        itemCount: 3,
        gross: '20.70',
        byTaxRate: [{ taxRate: '7.00', gross: '20.70', net: '19.35', tax: '1.35' }],
      },
    };
    api(withOrder(twice));
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    const lines = await screen.findAllByTestId('bill-line');
    expect(lines.map((l) => l.textContent)).toEqual(['3×Soup€20.70']);
    expect(screen.getByTestId('order-total').textContent).toBe('€20.70');
    expect(screen.getByText('VAT 7 % (net + VAT)')).toBeTruthy();
    // A waiter can't void.
    expect(screen.queryByTestId('void-items')).toBeNull();

    expect(screen.queryByTestId('print-bill')).toBeNull();
    await userEvent.click(screen.getByTestId('print-order'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const slip = within(document.getElementById('print-root')!).getByTestId('order-slip');
    expect(within(slip).getByText('3 × Soup')).toBeTruthy();
    expect(within(slip).getByText('Table T1')).toBeTruthy();
    // No payment details: no amounts, VAT or totals.
    expect(slip.textContent).not.toMatch(/€|VAT|TOTAL|receipt/i);
    expect(screen.getByTestId('close-order')).toBeTruthy();
  });

  it('moves the open order to a free table at its location (ADR 0069)', async () => {
    signedInAs('waiter');
    const writes = api({
      ...withOrder(ORDER),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            { ...TABLE, order: ORDER },
            { ...TABLE, id: id(5), name: 'T2', seatedAt: null, lastOrderAt: null, order: null },
          ],
        }),
      [`POST /api/v1/pos/orders/${ORDER.id}/move`]: () =>
        Response.json({ ...ORDER, tableId: id(5), tableName: 'T2' }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('move-order'));
    await userEvent.selectOptions(await screen.findByTestId('move-table'), id(5));
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes).toContainEqual({
        method: 'POST',
        path: `/api/v1/pos/orders/${ORDER.id}/move`,
        body: { tableId: id(5) },
      }),
    );
  });

  it('merges the open order into another open order at its location and opens that table (ADR 0069)', async () => {
    signedInAs('waiter');
    const other = { ...ORDER, id: id(25), tableId: id(5), number: 'ORD-2026-000002' };
    const writes = api({
      ...withOrder(ORDER),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            { ...TABLE, order: ORDER },
            {
              ...TABLE,
              id: id(5),
              name: 'T2',
              seatedAt: null,
              lastOrderAt: null,
              order: { ...other, tickets: undefined, totals: undefined },
            },
          ],
        }),
      [`POST /api/v1/pos/orders/${ORDER.id}/merge`]: () => Response.json({ ...other }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('merge-order'));
    await userEvent.selectOptions(await screen.findByTestId('merge-table'), id(5));
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes).toContainEqual({
        method: 'POST',
        path: `/api/v1/pos/orders/${ORDER.id}/merge`,
        body: { orderId: other.id },
      }),
    );
    await waitFor(() => expect(mockState.router.push).toHaveBeenCalledWith(`/service/${id(5)}`));
  });

  it('moves chosen items to a new order at a free table and opens it (ADR 0069)', async () => {
    signedInAs('waiter');
    const next = {
      ...ORDER,
      id: id(26),
      number: 'ORD-2026-000002',
      tableId: id(5),
      tableName: 'T2',
    };
    const writes = api({
      ...withOrder(ORDER),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            { ...TABLE, order: ORDER },
            { ...TABLE, id: id(5), name: 'T2', seatedAt: null, lastOrderAt: null, order: null },
          ],
        }),
      [`POST /api/v1/pos/orders/${ORDER.id}/transfer`]: () =>
        Response.json({ source: ORDER, target: next }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('transfer-order'));
    await userEvent.type(await screen.findByTestId('transfer-quantity'), '1');
    await userEvent.selectOptions(await screen.findByTestId('transfer-table'), id(5));
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes).toContainEqual({
        method: 'POST',
        path: `/api/v1/pos/orders/${ORDER.id}/transfer`,
        body: { tableId: id(5), lines: [{ lineId: id(31), quantity: 1 }] },
      }),
    );
    await waitFor(() => expect(mockState.router.push).toHaveBeenCalledWith(`/service/${id(5)}`));
  });

  it('lets a waiter print the bill with prices, like the cashier', async () => {
    signedInAs('waiter');
    api(withOrder(ORDER));
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await screen.findAllByTestId('bill-line');
    expect(screen.queryByTestId('print-order')).toBeNull();
    // While printing, the document is titled with the organization (any browser header names it).
    document.title = 'App';
    const titles: string[] = [];
    print.mockImplementationOnce(() => titles.push(document.title));
    await userEvent.click(screen.getByTestId('print-bill'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(titles).toEqual(['Demo Bistro']);
    expect(document.title).toBe('App');
    const printed = within(document.getElementById('print-root')!).getByTestId('printed-bill');
    expect(within(printed).getByTestId('order-total').textContent).toBe('€13.80');
    // No bill layout readable: the organization's name heads it, the default thanks ends it.
    expect(within(printed).getByTestId('bill-header').textContent).toBe('Demo Bistro');
    expect(within(printed).getByTestId('bill-thanks').textContent).toBe('Thank you for visiting!');
    expect(screen.getByTestId('close-order')).toBeTruthy();
  });

  it('bills what is unbilled once; with everything billed it reprints the check, same number', async () => {
    signedInAs('cashier');
    const writes = api(withOrder(ORDER));
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('print-bill'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(writes.filter((w) => w.path === '/api/v1/pos/bills').map((w) => w.body)).toEqual([
      { orderIds: [ORDER.id] },
    ]);
    cleanup();

    const billed: Order = {
      ...ORDER,
      unbilled: '0.00',
      bills: [
        {
          id: id(71),
          kind: 'single',
          shareCount: null,
          createdAt: '2026-10-27T12:30:00.000Z',
          cancelled: false,
          checks: [{ id: CHECK_ID, number: 'CHK-2026-000001', shareIndex: null, gross: '13.80' }],
        },
      ],
    };
    const again = api(withOrder(billed));
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    expect((await screen.findByTestId('print-bill')).textContent).toContain('Reprint bill');
    expect(screen.getByTestId('order-check').textContent).toContain('CHK-2026-000001');
    await userEvent.click(screen.getByTestId('print-bill'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(again.filter((w) => w.path === '/api/v1/pos/bills')).toEqual([]);
    const printed = within(document.getElementById('print-root')!).getByTestId('printed-bill');
    expect(within(printed).getByTestId('bill-number').textContent).toBe('Bill no. CHK-2026-000001');
  });

  it('lets a cashier see and print the bill with prices, without the menu', async () => {
    signedInAs('cashier');
    api({
      ...withOrder({ ...ORDER, covers: 3 }),
      'GET /api/v1/pos/bill-layout': () =>
        Response.json({
          header: {
            logo: 'data:image/png;base64,iVBORw0KGgo=',
            name: 'Bay Leaf',
            phone: '+49 30 1234567',
            email: null,
            website: 'www.bayleaf.example',
          },
          footer: { lines: ['Thank you for visiting!', 'Vielen Dank für Ihren Besuch!'] },
          printers: { bill: null },
          printerList: [],
        }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await screen.findAllByTestId('bill-line');
    expect(screen.queryAllByTestId('menu-product')).toEqual([]);
    expect(screen.queryByTestId('new-items')).toBeNull();
    expect(screen.queryByTestId('print-order')).toBeNull();
    await userEvent.click(screen.getByTestId('print-bill'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const printed = within(document.getElementById('print-root')!).getByTestId('printed-bill');
    expect(within(printed).getByTestId('order-total').textContent).toBe('€13.80');
    // ADR 0025: the organization's header (empty fields left out), the fixed middle, its footer.
    const header = within(printed).getByTestId('bill-header');
    expect(within(header).getByTestId('bill-logo')).toBeTruthy();
    expect(header.textContent).toBe('Bay Leaf+49 30 1234567www.bayleaf.example');
    expect(within(printed).getByTestId('bill-waiter').textContent).toBe('Waiter: Priya');
    expect(within(printed).getByTestId('bill-table').textContent).toBe('Table T1 · Guests 3');
    expect(within(printed).getByTestId('bill-number').textContent).toBe('Bill no. CHK-2026-000001');
    expect(within(printed).getAllByTestId('bill-line')[0]!.textContent).toBe(
      '2 × Soup€13.802 × €6.90',
    );
    expect(
      within(printed)
        .getAllByTestId('bill-thanks')
        .map((l) => l.textContent),
    ).toEqual(['Thank you for visiting!', 'Vielen Dank für Ihren Besuch!']);
    const footer = within(printed).getByTestId('bill-footer').textContent;
    expect(footer).toContain('Powered by Product');
    expect(footer).toMatch(/\d/);
    // A bill, not a receipt: no VAT breakdown and no TSE data.
    expect(printed.textContent).not.toMatch(/VAT|TSE/);
  });

  it('in the app, asks once which receipt printer this device uses, then prints there (ADR 0033)', async () => {
    signedInAs('cashier');
    const at = '2026-11-08T12:00:00.000Z';
    const printer = (n: number, name: string, overrides: object = {}) => ({
      id: id(90 + n),
      locationId: TABLE.locationId,
      name,
      host: `192.168.64.2${n}`,
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
      enabled: true,
      printsBills: true,
      stations: [],
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    });
    app.printer = {
      print: vi.fn(() => Promise.resolve({ state: 'sent', code: 'print.sent' })),
    };
    api({
      ...withOrder(ORDER),
      'GET /api/v1/pos/bill-layout': () =>
        Response.json({
          header: { logo: null, name: null, phone: null, email: null, website: null },
          footer: { lines: [] },
          printers: { bill: null },
          printerList: [
            printer(1, 'Till 1'),
            printer(2, 'Till 2'),
            // Off, or only for tickets: never offered for bills.
            printer(3, 'New', { enabled: false }),
            printer(4, 'Kitchen', { printsBills: false, stations: ['kitchen'] }),
          ],
        }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await screen.findAllByTestId('bill-line');
    await waitFor(() => expect(screen.getByTestId<HTMLButtonElement>('print-bill')).toBeTruthy());
    await userEvent.click(screen.getByTestId('print-bill'));
    const choose = await screen.findByTestId('native-print-choose');
    expect(
      within(choose)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Till 1', 'Till 2']);
    await userEvent.click(within(choose).getByText('Till 2'));
    await screen.findByText('Sent to the printer.');
    const settings = {
      host: '192.168.64.22',
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
    };
    expect(app.printer.print).toHaveBeenCalledWith(expect.any(String), expect.anything(), settings);

    // The next bill goes straight to this device's choice.
    await userEvent.click(screen.getByTestId('print-bill'));
    await waitFor(() => expect(app.printer!.print).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('native-print-choose')).toBeNull();
    expect(app.printer.print).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      settings,
    );
    expect(print).not.toHaveBeenCalled();
  });

  it('leaves a ticket that a printer of the location prints to the till (ADR 0033)', async () => {
    signedInAs('waiter');
    const ticketId = ORDER.tickets[0]!.id;
    api({
      ...withOrder(null),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () =>
        Response.json(
          { order: ORDER, ticketId, ticketIds: [ticketId], printQueuedIds: [ticketId] },
          { status: 201 },
        ),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    const soup = await screen.findAllByTestId('menu-product');
    await userEvent.click(soup.find((b) => b.dataset.name === 'Soup')!);
    await userEvent.click(screen.getByTestId('send-to-kitchen'));
    expect(await screen.findByText('Sent: ticket 1 (Kitchen).')).toBeTruthy();
    // Not on this device: no print screen, nothing in the print-only root.
    expect(print).not.toHaveBeenCalled();
    expect(document.getElementById('print-root')?.textContent ?? '').toBe('');
  });

  it("in a browser, sends the bill to the till's receipt printer instead of the print screen", async () => {
    signedInAs('cashier');
    const at = '2026-11-09T12:00:00.000Z';
    const receipt = (n: number, name: string) => ({
      id: id(90 + n),
      locationId: TABLE.locationId,
      name,
      host: `192.168.64.2${n}`,
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
      enabled: true,
      printsBills: true,
      stations: [],
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    const writes = api({
      ...withOrder(ORDER),
      'GET /api/v1/pos/bill-layout': () =>
        Response.json({
          header: { logo: null, name: null, phone: null, email: null, website: null },
          footer: { lines: [] },
          printers: { bill: null },
          printerList: [receipt(1, 'Till 1'), receipt(2, 'Till 2')],
        }),
      'POST /api/v1/pos/print-jobs/bill': () =>
        Response.json(
          {
            id: id(80),
            locationId: TABLE.locationId,
            printerId: id(92),
            kind: 'bill',
            orderId: ORDER.id,
            ticketId: null,
            checkId: null,
            status: 'pending',
            stale: false,
            expired: false,
            attempts: 0,
            lastCode: null,
            notBefore: at,
            expiresAt: '2026-11-09T12:10:00.000Z',
            createdAt: at,
            claimedAt: null,
            completedAt: null,
          },
          { status: 201 },
        ),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await screen.findAllByTestId('bill-line');
    await userEvent.click(screen.getByTestId('print-bill'));
    // Two receipt printers: this device chooses once.
    const choose = await screen.findByTestId('native-print-choose');
    await userEvent.click(within(choose).getByText('Till 2'));
    expect(await screen.findByText('Sent to Till 2. The till prints it.')).toBeTruthy();
    await userEvent.click(screen.getByTestId('print-bill'));
    await waitFor(() => expect(writes.filter((w) => w.path.endsWith('/bill'))).toHaveLength(2));
    expect(writes.filter((w) => w.path.endsWith('/bill')).map((w) => w.body)).toEqual([
      { orderId: ORDER.id, printerId: id(92), checkId: CHECK_ID },
      { orderId: ORDER.id, printerId: id(92), checkId: CHECK_ID },
    ]);
    expect(print).not.toHaveBeenCalled();
  });

  it('focuses the menu search with "/"', async () => {
    signedInAs('waiter');
    api(withOrder(null));
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await screen.findAllByTestId('menu-product');
    await userEvent.keyboard('/');
    expect(document.activeElement).toBe(screen.getByLabelText('Search the menu'));
    await userEvent.type(screen.getByLabelText('Search the menu'), 'col');
    expect(screen.getAllByTestId('menu-product').map((b) => b.dataset.name)).toEqual(['Cola']);
  });

  it('lets a manager void a sent item and prints the VOID ticket', async () => {
    signedInAs('manager');
    const voided: Order = {
      ...ORDER,
      tickets: [
        ...ORDER.tickets,
        {
          id: id(23),
          sequence: 2,
          kind: 'void',
          station: 'kitchen',
          status: 'new',
          direct: false,
          createdAt: '2026-10-27T12:05:00.000Z',
          lines: [{ ...line(4, id(23), SOUP, -1, 0), voidsLineId: id(31) }],
        },
      ],
    };
    const writes = api({
      ...withOrder(ORDER),
      [`POST /api/v1/pos/orders/${ORDER.id}/voids`]: () =>
        Response.json({ order: voided, ticketId: id(23), ticketIds: [id(23)] }, { status: 201 }),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('void-items'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Choose at least one item.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Cancel how many Soup'), '1');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/pos/orders/${ORDER.id}/voids`,
        body: { lines: [{ lineId: id(31), quantity: 1 }] },
      },
    ]);
    const ticket = within(document.getElementById('print-root')!).getByTestId('kitchen-ticket');
    expect(within(ticket).getByText('CANCELLED')).toBeTruthy();
  });
  // ADR 0026: what the kitchen marked ready shows on the till until a waiter serves it.
  it('shows ready tickets and lets a waiter mark one served', async () => {
    signedInAs('waiter');
    const ready: Order = {
      ...ORDER,
      readyCount: 1,
      tickets: [{ ...ORDER.tickets[0]!, status: 'ready' }],
    };
    const served: Order = {
      ...ORDER,
      tickets: [{ ...ORDER.tickets[0]!, status: 'served' }],
    };
    let current = ready;
    const writes = api({
      ...menu,
      [`GET /api/v1/pos/tables/${TABLE.id}/order`]: () =>
        Response.json({ table: TABLE, order: current, processing: ON }),
      [`POST /api/v1/pos/orders/${ORDER.id}/tickets/${id(21)}/served`]: () => {
        current = served;
        return Response.json(served, { status: 201 });
      },
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    expect((await screen.findByTestId('till-ready')).textContent).toBe('Ready to serve: 1');
    expect(screen.getByTestId('ticket-status').textContent).toBe('Ready');
    await userEvent.click(screen.getByTestId('ticket-serve'));
    await waitFor(() => expect(screen.getByTestId('ticket-status').textContent).toBe('Served'));
    expect(screen.queryByTestId('till-ready')).toBeNull();
    expect(screen.queryByTestId('ticket-serve')).toBeNull();
    expect(writes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/pos/orders/${ORDER.id}/tickets/${id(21)}/served`,
        body: {},
      },
    ]);
  });

  it('shows the status but no Served button to a cashier', async () => {
    signedInAs('cashier');
    api(
      withOrder({ ...ORDER, readyCount: 1, tickets: [{ ...ORDER.tickets[0]!, status: 'ready' }] }),
    );
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    expect(await screen.findByTestId('till-ready')).toBeTruthy();
    expect(screen.queryByTestId('ticket-serve')).toBeNull();
  });
});

/** /service with reservations (docs/modules/reservations.md → Web, R1.9): composed in the web. */
describe('with reservations', () => {
  const resTable = (tableId: string, name: string, over: object = {}) => ({
    id: tableId,
    locationId: LOCATION.id,
    name,
    seats: 4,
    areaId: null,
    area: null,
    shape: 'square',
    color: 'neutral',
    sortOrder: 0,
    state: 'free',
    overrun: false,
    walkInOnly: false,
    current: null,
    next: null,
    occupied: false,
    occupiedSince: null,
    covers: null,
    ...over,
  });
  const seated = {
    state: 'occupied',
    occupied: true,
    occupiedSince: '2027-03-06T17:40:00.000Z',
    covers: 3,
    current: {
      reservationId: id(40),
      partySize: 3,
      guestName: 'Weber',
      since: '2027-03-06T17:40:00.000Z',
      until: '2027-03-06T19:10:00.000Z',
    },
  };
  const reservationsFloor = (tables: object[]) => () =>
    Response.json({
      data: tables,
      at: '2027-03-06T17:45:00.000Z',
      date: '2027-03-06',
      live: true,
      timeZone: 'Europe/Berlin',
      horizonMinutes: 60,
      serviceWindows: [],
    });

  function signedInWithReservations() {
    mockState.session = sessionFixture({
      activePermissions: [...systemRolePermissions('waiter')],
      activeFeatures: ['catalog', 'pos', 'reservations'],
    });
  }

  const posFloor = {
    ...SETTINGS,
    'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
    'GET /api/v1/pos/floor': () =>
      Response.json({
        data: [
          { ...TABLE, order: null },
          { ...TABLE, id: id(5), name: 'T2', order: null },
        ],
      }),
  };

  it("shows the next booking and a table seated from one on the floor's tiles", async () => {
    signedInWithReservations();
    api({
      ...posFloor,
      'GET /api/v1/reservations/floor': reservationsFloor([
        resTable(TABLE.id, 'T1', seated),
        resTable(id(5), 'T2', {
          next: {
            reservationId: id(41),
            startsAt: '2027-03-06T18:30:00.000Z',
            partySize: 4,
            guestName: 'Klein',
            tableStillOccupied: false,
          },
        }),
      ]),
    });
    render(<FloorPage />);
    const [t1, t2] = await screen.findAllByTestId('floor-table');
    expect((await within(t1!).findByTestId('floor-booking')).textContent).toBe('From booking');
    expect(within(t2!).getByTestId('floor-booking').textContent).toBe('19:30 · 4 p.');
  });

  it('never calls reservations without the feature, and hides the badges when the call fails', async () => {
    signedInAs('waiter');
    api(posFloor);
    render(<FloorPage />);
    await screen.findAllByTestId('floor-table');
    expect(
      mockState.store.apiFetch.mock.calls.some(([path]) =>
        String(path).startsWith('/api/v1/reservations'),
      ),
    ).toBe(false);
    cleanup();

    signedInWithReservations();
    api({
      ...posFloor,
      'GET /api/v1/reservations/floor': () =>
        Response.json({ code: 'reservations.busy', message: 'x' }, { status: 503 }),
    });
    render(<FloorPage />);
    await screen.findAllByTestId('floor-table');
    expect(screen.queryByTestId('floor-booking')).toBeNull();
  });

  it("pre-fills the guests with the seated booking's party; the waiter can change it", async () => {
    signedInWithReservations();
    const writes = api({
      ...withOrder(null),
      'GET /api/v1/reservations/floor': reservationsFloor([resTable(TABLE.id, 'T1', seated)]),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () =>
        Response.json(
          { order: { ...ORDER, covers: 2 }, ticketId: id(21), ticketIds: [id(21)] },
          { status: 201 },
        ),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    // The field remounts once the booking's party arrives: query it afresh.
    await waitFor(() => expect(screen.getByTestId('guests-value').textContent).toBe('3'));
    const field = screen.getByTestId('guests');
    await userEvent.click(within(field).getByRole('button', { name: 'Fewer guests' }));
    expect(within(field).getByTestId('guests-value').textContent).toBe('2');
    await userEvent.click(
      (await screen.findAllByTestId('menu-product')).find((x) => x.textContent?.includes('Soup'))!,
    );
    await userEvent.click(screen.getByTestId('send-to-kitchen'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({ covers: 2 });
  });

  it('sends the pre-filled guests when the waiter leaves them', async () => {
    signedInWithReservations();
    const writes = api({
      ...withOrder(null),
      'GET /api/v1/reservations/floor': reservationsFloor([resTable(TABLE.id, 'T1', seated)]),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () =>
        Response.json(
          { order: { ...ORDER, covers: 3 }, ticketId: id(21), ticketIds: [id(21)] },
          { status: 201 },
        ),
    });
    render(<OrderPage tableId={TABLE.id} />, { wrapper: Brand });
    // The field remounts once the booking's party arrives: query it afresh.
    await waitFor(() => expect(screen.getByTestId('guests-value').textContent).toBe('3'));
    await userEvent.click(
      (await screen.findAllByTestId('menu-product')).find((x) => x.textContent?.includes('Soup'))!,
    );
    await userEvent.click(screen.getByTestId('send-to-kitchen'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({ covers: 3 });
  });
});
