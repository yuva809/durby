// @vitest-environment jsdom
import type { Order } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { SplitDialog } from './split-dialog';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;
const LOCATION = id(8);

const line = (
  n: number,
  productName: string,
  unitPrice: string,
  remaining: number,
  billed = 0,
) => ({
  id: id(n),
  productName,
  unitPrice,
  quantity: remaining,
  remaining,
  billedQuantity: billed,
});

const ORDER = {
  id: id(1),
  number: 'ORD-2026-000001',
  status: 'open',
  covers: 3,
  unbilled: '20.30',
  tickets: [
    {
      id: id(2),
      lines: [
        line(3, 'Soup', '6.90', 2, 1),
        line(4, 'Water', '2.50', 3),
        line(9, 'Tea', '3.10', 2, 2),
      ],
    },
  ],
} as unknown as Order;

const BILL = (checks: number) => ({
  id: id(40),
  kind: checks > 1 ? 'equal' : 'single',
  shareCount: checks > 1 ? checks : null,
  createdAt: '2026-11-13T12:00:00.000Z',
  cancelled: false,
  checks: Array.from({ length: checks }, (_, i) => ({
    id: id(50 + i),
    number: `CHK-2026-00000${i + 1}`,
    shareIndex: checks > 1 ? i + 1 : null,
    gross: '1.00',
  })),
  locationId: LOCATION,
  orderIds: [id(1)],
  gross: '20.30',
});

/** Answers the bill (and, for joining, the floor); returns the bodies sent to POST /pos/bills. */
function api(checks = 1) {
  const sent: unknown[] = [];
  mockState.store.apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.startsWith('/api/v1/pos/floor')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: id(60),
              locationId: LOCATION,
              name: 'T7',
              seats: 4,
              area: null,
              shape: 'square',
              color: 'neutral',
              seatedAt: null,
              lastOrderAt: null,
              order: {
                id: id(61),
                number: 'ORD-2026-000007',
                tableId: id(60),
                tableName: 'T7',
                locationId: LOCATION,
                status: 'open',
                openedAt: '2026-11-13T11:00:00.000Z',
                closedAt: null,
                covers: 2,
                itemCount: 3,
                gross: '12.00',
                readyCount: 0,
                unbilled: '12.00',
              },
            },
          ],
        }),
      );
    }
    sent.push(JSON.parse(init?.body as string));
    return Promise.resolve(Response.json(BILL(checks), { status: 201 }));
  });
  return sent;
}

const open = async () => {
  render(<SplitDialog order={ORDER} locationId={LOCATION} onBilled={onBilled} />);
  await userEvent.click(screen.getByTestId('split-bill'));
};
const onBilled = vi.fn();

describe('SplitDialog', () => {
  it('picks items with + and All, shows the bill total, and bills them', async () => {
    const sent = api();
    await open();
    // Only what is still unbilled: Tea is fully billed.
    const rows = screen.getAllByTestId('split-line');
    expect(rows.map((r) => r.dataset.name)).toEqual(['Soup', 'Water']);
    await userEvent.click(within(rows[0]!).getByTestId('split-more'));
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'All' }));
    // 1 Soup (6.90) + 3 Water (7.50) = 14.40
    expect(screen.getByTestId('split-summary').textContent).toContain('4 items on this bill');
    expect(screen.getByTestId('split-summary').textContent).toContain('14.40');
    // Soup has 1 left: + stops there.
    expect(within(rows[0]!).getByTestId('split-more').hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    await waitFor(() => expect(onBilled).toHaveBeenCalledWith(id(50)));
    expect(sent[0]).toEqual({
      orderIds: [id(1)],
      items: [
        { orderLineId: id(3), quantity: 1 },
        { orderLineId: id(4), quantity: 3 },
      ],
    });
  });

  it('asks for at least one item instead of sending an empty bill', async () => {
    const sent = api();
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('splits equally, starting from the guests at the table, with a per-guest preview', async () => {
    const sent = api(4);
    await open();
    await userEvent.click(screen.getByTestId('split-mode-equal'));
    // The table has 3 guests: 20.30 / 3 ≈ 6.76, with a cent more for some.
    expect(screen.getByTestId('split-guests').textContent).toBe('3');
    expect(screen.getByTestId('split-each').textContent).toContain('6.76');
    expect(screen.getByTestId('split-each').textContent).toContain('a cent more');
    await userEvent.click(screen.getAllByTestId('split-guests-quick')[2]!);
    await userEvent.click(screen.getByRole('button', { name: 'Create 4 checks' }));
    await waitFor(() => expect(sent).toEqual([{ orderIds: [id(1)], shares: 4 }]));
  });

  it('joins another open table, showing the combined total', async () => {
    const sent = api();
    await open();
    await userEvent.click(screen.getByTestId('split-mode-merge'));
    await userEvent.click(await screen.findByTestId('split-merge-table'));
    // 20.30 + 12.00
    expect(screen.getByTestId('split-summary').textContent).toContain('32.30');
    await userEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    await waitFor(() => expect(sent).toEqual([{ orderIds: [id(1), id(61)] }]));
  });
});
