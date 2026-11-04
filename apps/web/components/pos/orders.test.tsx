// @vitest-environment jsdom
import type { Order } from '@durby/shared';
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { times } from '../../lib/pos/format';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
import { FloorPage } from './floor-page';
import { OrderPage } from './order-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

const print = vi.fn();

/** The till names the product on the bill ("Powered by"). */
const Brand = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>{children}</BrandProvider>
);

beforeEach(() => {
  resetMocks();
  print.mockReset();
  window.print = print;
});
afterEach(() => {
  cleanup();
  document.getElementById('print-root')?.remove();
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(1), name: 'Main street', brandId: id(2) };
const TABLE = {
  id: id(3),
  locationId: LOCATION.id,
  name: 'T1',
  seats: 4,
  area: null,
  shape: 'square',
  color: 'neutral',
};
const FOOD = { id: id(4), name: 'Food', sortOrder: 0, station: 'kitchen', archivedAt: null };
const product = (n: number, name: string, price: string, taxRate: string) => ({
  id: id(10 + n),
  categoryId: FOOD.id,
  name,
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

const withOrder = (order: Order | null) => ({
  ...menu,
  [`GET /api/v1/pos/tables/${TABLE.id}/order`]: () => Response.json({ table: TABLE, order }),
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
    expect(await screen.findByText('Sent: ticket 1.')).toBeTruthy();
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
  it('prints the kitchen and the bar ticket of one send as two print jobs', async () => {
    signedInAs('waiter');
    const ticket = (n: number, station: 'kitchen' | 'bar', l: ReturnType<typeof line>) => ({
      id: id(n),
      sequence: n - 21,
      kind: 'order' as const,
      station,
      status: 'new' as const,
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
        Response.json({ table: TABLE, order: current }),
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
    expect(await screen.findByText('Sent: ticket 1, 2.')).toBeTruthy();
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
    expect(within(printed).getByText('This is not a receipt.')).toBeTruthy();
    expect(within(printed).getByTestId('order-total').textContent).toBe('€13.80');
    // ADR 0025: the organization's header (empty fields left out), the fixed middle, its footer.
    const header = within(printed).getByTestId('bill-header');
    expect(within(header).getByTestId('bill-logo')).toBeTruthy();
    expect(header.textContent).toBe('Bay Leaf+49 30 1234567www.bayleaf.example');
    expect(within(printed).getByTestId('bill-waiter').textContent).toBe('Waiter: Priya');
    expect(within(printed).getByTestId('bill-table').textContent).toBe('Table T1 · Guests 3');
    expect(within(printed).getByTestId('bill-number').textContent).toBe(`Bill no. ${ORDER.number}`);
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
        Response.json({ table: TABLE, order: current }),
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
