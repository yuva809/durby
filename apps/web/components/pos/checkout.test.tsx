// @vitest-environment jsdom
import type { GuestCheck } from '@durby/shared';
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
import { CheckoutPage } from './checkout-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

const print = vi.fn();
const Brand = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>{children}</BrandProvider>
);

beforeEach(() => {
  resetMocks();
  print.mockReset();
  window.print = print;
  // Radix measures its popper and tabs content.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  document.getElementById('print-root')?.remove();
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
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
const SUMMARY = {
  id: id(20),
  number: 'ORD-2026-000001',
  tableId: TABLE.id,
  tableName: 'T1',
  locationId: LOCATION.id,
  status: 'open',
  openedAt: '2026-11-12T12:00:00.000Z',
  closedAt: null,
  covers: null,
  itemCount: 3,
  gross: '17.60',
  readyCount: 0,
  unbilled: '3.80',
};
const CHECK: GuestCheck = {
  id: id(30),
  number: 'CHK-2026-000007',
  billId: id(31),
  locationId: LOCATION.id,
  shareIndex: null,
  shareCount: null,
  createdAt: '2026-11-12T12:30:00.000Z',
  cancelled: false,
  cancelledAt: null,
  orders: [
    {
      id: SUMMARY.id,
      number: SUMMARY.number,
      tableId: TABLE.id,
      tableName: 'T1',
      covers: 2,
      waiterName: 'Priya',
    },
  ],
  lines: [
    {
      kind: 'item',
      name: 'Soup',
      quantity: 2,
      unitPrice: '6.90',
      taxRate: '7.00',
      total: '13.80',
    },
  ],
  totals: {
    itemCount: 2,
    gross: '13.80',
    byTaxRate: [{ taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' }],
  },
};
const ROW = {
  id: CHECK.id,
  number: CHECK.number,
  billId: CHECK.billId,
  locationId: LOCATION.id,
  shareIndex: null,
  shareCount: null,
  gross: '13.80',
  createdAt: CHECK.createdAt,
  cancelled: false,
  tableNames: ['T1'],
  orderNumbers: [SUMMARY.number],
};

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

/** Answers by method and path; records the calls. */
function api(answers: Record<string, () => Response> = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: input, body: init?.body ? JSON.parse(init.body as string) : null });
    const path = input.replace(/\?.*$/, '');
    const all: Record<string, () => Response> = {
      'GET /api/v1/settings': () =>
        Response.json({
          data: [
            { key: 'locale', value: 'en', source: 'default', dataBound: false },
            { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
          ],
        }),
      'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
      'GET /api/v1/pos/floor': () =>
        Response.json({
          data: [
            { ...TABLE, order: SUMMARY },
            { ...TABLE, id: id(4), name: 'T2', order: null },
          ],
        }),
      'GET /api/v1/pos/checks': () => Response.json({ data: [ROW], nextCursor: null }),
      [`GET /api/v1/pos/checks/${CHECK.id}`]: () => Response.json(CHECK),
      ...answers,
    };
    const answer = all[`${method} ${path}`];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
  return calls;
}

describe('CheckoutPage (docs/modules/pos.md → Step 4)', () => {
  it('lists the open tables with what is still to bill, linking to the till', async () => {
    signedInAs('cashier');
    api();
    render(<CheckoutPage />, { wrapper: Brand });
    const rows = await screen.findAllByTestId('checkout-open-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByTestId('checkout-unbilled').textContent).toBe('To bill €3.80');
    expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe(`/service/${TABLE.id}`);
  });

  it('opens a recent check as its receipt and reprints it with the same number', async () => {
    signedInAs('cashier');
    const calls = api();
    render(<CheckoutPage />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('checkout-tab-recent'));
    const row = await screen.findByTestId('checkout-check-row');
    expect(row.textContent).toContain('CHK-2026-000007');
    expect(calls.some((c) => c.url.includes('/api/v1/pos/checks?view=recent'))).toBe(true);
    await userEvent.click(within(row).getByTestId('checkout-view-check'));
    const shown = await screen.findByTestId('checkout-check');
    expect(within(shown).getByTestId('bill-number').textContent).toBe('Bill no. CHK-2026-000007');
    // A cashier can't cancel.
    expect(screen.queryByTestId('checkout-cancel-bill')).toBeNull();
    await userEvent.click(screen.getByTestId('checkout-reprint'));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const printed = within(document.getElementById('print-root')!).getByTestId('printed-bill');
    expect(within(printed).getByTestId('bill-number').textContent).toBe('Bill no. CHK-2026-000007');
  });

  it('lets a manager cancel a bill with a reason', async () => {
    signedInAs('manager');
    const calls = api({
      [`POST /api/v1/pos/bills/${CHECK.billId}/cancel`]: () =>
        Response.json(
          {
            id: CHECK.billId,
            kind: 'single',
            shareCount: null,
            createdAt: CHECK.createdAt,
            cancelled: true,
            checks: [{ id: CHECK.id, number: CHECK.number, shareIndex: null, gross: '13.80' }],
            locationId: LOCATION.id,
            orderIds: [SUMMARY.id],
            gross: '13.80',
          },
          { status: 201 },
        ),
    });
    render(<CheckoutPage />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('checkout-tab-recent'));
    await userEvent.click(await screen.findByTestId('checkout-view-check'));
    await userEvent.click(await screen.findByTestId('checkout-cancel-bill'));
    await userEvent.type(screen.getByTestId('checkout-cancel-reason'), 'wrong table');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        { reason: 'wrong table' },
      ]),
    );
  });

  it('searches the history by number and pages through it', async () => {
    signedInAs('cashier');
    const calls = api({
      'GET /api/v1/pos/checks': () =>
        Response.json({ data: [ROW], nextCursor: calls.length > 6 ? null : CHECK.id }),
    });
    render(<CheckoutPage />, { wrapper: Brand });
    await userEvent.click(await screen.findByTestId('checkout-tab-history'));
    await userEvent.type(screen.getByTestId('checkout-search'), '0007');
    await userEvent.click(screen.getByTestId('checkout-search-button'));
    await screen.findByTestId('checkout-check-row');
    const search = calls.find((c) => c.url.includes('view=history'))!.url;
    expect(search).toContain('q=0007');
    expect(search).toContain(`locationId=${LOCATION.id}`);
    await userEvent.click(screen.getByTestId('checkout-more'));
    await waitFor(() => expect(screen.getAllByTestId('checkout-check-row')).toHaveLength(2));
    expect(calls.some((c) => c.url.includes(`cursor=${CHECK.id}`))).toBe(true);
  });

  it('is closed to roles without pos.bills.print', () => {
    signedInAs('staff');
    api();
    render(<CheckoutPage />, { wrapper: Brand });
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});
