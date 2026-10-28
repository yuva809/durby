// @vitest-environment jsdom
import type { Order } from '@durby/shared';
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { times } from '../../lib/pos/format';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { FloorPage } from './floor-page';
import { OrderPage } from './order-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

const print = vi.fn();

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
const FOOD = { id: id(4), name: 'Food', sortOrder: 0, archivedAt: null };
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
  itemCount: 2,
  gross: '13.80',
  tickets: [
    {
      id: id(21),
      sequence: 1,
      kind: 'order',
      createdAt: '2026-10-27T12:00:00.000Z',
      lines: [line(1, id(21), SOUP, 2, 2)],
    },
  ],
  totals: {
    itemCount: 2,
    gross: '13.80',
    byTaxRate: [{ taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' }],
  },
};

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
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
    expect(within(tiles[0]!).getByRole('link').getAttribute('href')).toBe(`/pos/order/${TABLE.id}`);
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

describe('OrderPage (till)', () => {
  const tile = async (name: string) =>
    (await screen.findAllByTestId('menu-product')).find((b) => b.dataset.name === name)!;

  it('builds the order on the receipt, sends it to the kitchen and prints the ticket', async () => {
    signedInAs('waiter');
    const sent: Order = {
      ...ORDER,
      tickets: [
        {
          id: id(22),
          sequence: 1,
          kind: 'order',
          createdAt: '2026-10-27T12:00:00.000Z',
          lines: [line(2, id(22), SOUP, 2, 2), { ...line(3, id(22), COLA, 1, 1), note: 'no ice' }],
        },
      ],
    };
    const writes = api({
      ...withOrder(null),
      [`POST /api/v1/pos/tables/${TABLE.id}/tickets`]: () =>
        Response.json({ order: sent, ticketId: id(22) }, { status: 201 }),
    });
    render(<OrderPage tableId={TABLE.id} />);
    expect(within(await screen.findByTestId('table-bar')).getByText('T1')).toBeTruthy();
    expect(screen.queryByTestId('send-to-kitchen')).toBeNull();

    // Category chips carry their product counts.
    const chips = await screen.findByTestId('category-chips');
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All categories2', 'Food2']);

    await userEvent.click(await tile('Soup'));
    await userEvent.click(await tile('Soup'));
    await userEvent.click(await tile('Cola'));
    expect(within(await tile('Soup')).getByTestId('menu-count').textContent).toBe('2');
    expect(screen.getAllByTestId('receipt-new').map((l) => l.dataset.name)).toEqual([
      'Soup',
      'Cola',
    ]);
    expect(screen.getByTestId('to-send').textContent).toBe('3 to send · Send to kitchen');

    // The last added line is selected: quantity, note, remove.
    const controls = screen.getByTestId('line-controls');
    await userEvent.type(within(controls).getByLabelText('Note for Cola'), 'no ice');
    await userEvent.click(within(controls).getByRole('button', { name: 'One more Cola' }));
    await userEvent.click(within(controls).getByRole('button', { name: 'One less Cola' }));
    expect(within(controls).getByTestId('cart-quantity').textContent).toBe('1');
    expect(screen.getByTestId('order-total').textContent).toBe('€17.60');
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
    expect(await screen.findByText('Sent to the kitchen: ticket 1.')).toBeTruthy();
    // The ticket is in the print-only root: items and notes, no prices.
    const ticket = within(document.getElementById('print-root')!).getByTestId('kitchen-ticket');
    expect(within(ticket).getByText('Table T1')).toBeTruthy();
    expect(within(ticket).getByText('2 × Soup')).toBeTruthy();
    expect(within(ticket).getByText('no ice')).toBeTruthy();
    expect(within(ticket).queryByText(/13\.80/)).toBeNull();
  });

  it('removes a NEW line from the receipt', async () => {
    signedInAs('waiter');
    api(withOrder(null));
    render(<OrderPage tableId={TABLE.id} />);
    await userEvent.click(await tile('Soup'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryAllByTestId('receipt-new')).toEqual([]);
    expect(screen.queryByTestId('send-to-kitchen')).toBeNull();
  });

  it('combines sent items on the bill and prints it, marked as not a receipt', async () => {
    signedInAs('waiter');
    const twice: Order = {
      ...ORDER,
      tickets: [
        ...ORDER.tickets,
        {
          id: id(24),
          sequence: 2,
          kind: 'order',
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
    render(<OrderPage tableId={TABLE.id} />);
    const lines = await screen.findAllByTestId('bill-line');
    expect(lines.map((l) => l.textContent)).toEqual(['Soup3 × €6.90€20.70']);
    expect(screen.getByTestId('order-total').textContent).toBe('€20.70');
    expect(screen.getByText('VAT 7 % (net + VAT)')).toBeTruthy();

    // A waiter can't void: selecting a sent line shows no Void.
    await userEvent.click(within(lines[0]!).getByRole('button'));
    expect(screen.queryByTestId('void-items')).toBeNull();

    await userEvent.click(screen.getByTestId('print-bill'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const printed = within(document.getElementById('print-root')!).getByTestId('printed-bill');
    expect(within(printed).getByText('This is not a receipt.')).toBeTruthy();
    expect(within(printed).getByTestId('order-total').textContent).toBe('€20.70');
    expect(screen.getByTestId('close-order')).toBeTruthy();
  });

  it('lets a cashier see and print the bill without the menu', async () => {
    signedInAs('cashier');
    api(withOrder(ORDER));
    render(<OrderPage tableId={TABLE.id} />);
    await screen.findAllByTestId('bill-line');
    expect(screen.queryAllByTestId('menu-product')).toEqual([]);
    expect(screen.queryByTestId('send-to-kitchen')).toBeNull();
    expect(screen.getByTestId('print-bill')).toBeTruthy();
  });

  it('focuses the menu search with "/"', async () => {
    signedInAs('waiter');
    api(withOrder(null));
    render(<OrderPage tableId={TABLE.id} />);
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
          createdAt: '2026-10-27T12:05:00.000Z',
          lines: [{ ...line(4, id(23), SOUP, -1, 0), voidsLineId: id(31) }],
        },
      ],
    };
    const writes = api({
      ...withOrder(ORDER),
      [`POST /api/v1/pos/orders/${ORDER.id}/voids`]: () =>
        Response.json({ order: voided, ticketId: id(23) }, { status: 201 }),
    });
    render(<OrderPage tableId={TABLE.id} />);
    const [soup] = await screen.findAllByTestId('bill-line');
    await userEvent.click(within(soup!).getByRole('button'));
    await userEvent.click(await screen.findByTestId('void-items'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Choose at least one item.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Void how many Soup'), '1');
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
    expect(within(ticket).getByText('VOID')).toBeTruthy();
  });
});
