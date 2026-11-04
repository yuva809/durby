// @vitest-environment jsdom
import { type StationTicket, type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS, visibleNav } from '../../lib/nav/registry';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { StationBoardPage } from './station-board';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const ticket = (n: number, extra: Partial<StationTicket> = {}): StationTicket => ({
  id: id(10 + n),
  orderId: id(30),
  orderNumber: 'ORD-2026-000001',
  tableName: `T${n}`,
  sequence: n,
  kind: 'order',
  status: 'new',
  createdAt: minutesAgo(3),
  statusAt: minutesAgo(3),
  lines: [{ id: id(50 + n), productName: 'Soup', quantity: 2, note: 'no salt' }],
  ...extra,
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

/** The board answers `tickets`; moves are recorded and answered with the moved ticket. */
function api(tickets: StationTicket[]) {
  const writes: { path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      const body = JSON.parse(init!.body as string) as { status: StationTicket['status'] };
      writes.push({ path: input, body });
      const moved = tickets.find((t) => input.includes(t.id))!;
      return Promise.resolve(Response.json({ ...moved, status: body.status }, { status: 201 }));
    }
    if (input.startsWith('/api/v1/locations'))
      return Promise.resolve(Response.json({ data: [MAIN] }));
    if (input.startsWith('/api/v1/pos/stations/')) {
      return Promise.resolve(Response.json({ data: tickets }));
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return writes;
}

describe('StationBoardPage', () => {
  it('is in the nav for Kitchen and Bar by their key, not for waiters', () => {
    const nav = (role: SystemRole) =>
      visibleNav(NAV_ITEMS, {
        activePermissions: [...systemRolePermissions(role)],
        activeFeatures: ['pos'],
      }).map((item) => item.id);
    expect(nav('kitchen')).toContain('kitchen');
    expect(nav('kitchen')).not.toContain('bar');
    expect(nav('bar')).toContain('bar');
    expect(nav('waiter')).not.toContain('kitchen');
    expect(nav('manager')).toEqual(expect.arrayContaining(['kitchen', 'bar']));
  });

  it('puts tickets in New, Preparing and Ready, with table, items, notes and age', async () => {
    signedInAs('kitchen');
    api([
      ticket(1),
      ticket(2, { status: 'preparing', createdAt: minutesAgo(12) }),
      ticket(3, { status: 'ready', createdAt: minutesAgo(25) }),
    ]);
    render(<StationBoardPage station="kitchen" />);
    const board = await screen.findByTestId('station-board');
    const tables = (column: string) =>
      within(within(board).getByTestId(`column-${column}`))
        .queryAllByTestId('station-ticket')
        .map((c) => c.dataset.table);
    expect(tables('new')).toEqual(['T1']);
    expect(tables('preparing')).toEqual(['T2']);
    expect(tables('ready')).toEqual(['T3']);
    const first = within(board).getAllByTestId('station-ticket')[0]!;
    expect(within(first).getByText('Table T1')).toBeTruthy();
    expect(within(first).getByText('no salt')).toBeTruthy();
    expect(within(first).getByTestId('ticket-age').textContent).toBe('3 min');
  });

  it('moves a card with its one big button, and undoes ready', async () => {
    signedInAs('kitchen');
    const writes = api([ticket(1), ticket(2, { status: 'ready' })]);
    render(<StationBoardPage station="kitchen" />);
    const cards = await screen.findAllByTestId('station-ticket');
    expect(within(cards[0]!).getByTestId('ticket-next').textContent).toBe('Start');
    await userEvent.click(within(cards[0]!).getByTestId('ticket-next'));
    expect(within(cards[1]!).getByTestId('ticket-next').textContent).toBe('Served');
    await userEvent.click(within(cards[1]!).getByTestId('ticket-undo'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      {
        path: `/api/v1/pos/stations/kitchen/tickets/${id(11)}/status`,
        body: { status: 'preparing' },
      },
      {
        path: `/api/v1/pos/stations/kitchen/tickets/${id(12)}/status`,
        body: { status: 'preparing' },
      },
    ]);
  });

  it('shows a cancelled ticket that the cook only marks as seen', async () => {
    signedInAs('bar');
    const writes = api([
      ticket(1, {
        kind: 'void',
        lines: [{ id: id(60), productName: 'Beer', quantity: -1, note: null }],
      }),
    ]);
    render(<StationBoardPage station="bar" />);
    const card = await screen.findByTestId('station-ticket');
    expect(within(card).getByText('CANCELLED')).toBeTruthy();
    await userEvent.click(within(card).getByTestId('ticket-next'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: `/api/v1/pos/stations/bar/tickets/${id(11)}/status`,
      body: { status: 'served' },
    });
  });

  it('is not for waiters', () => {
    signedInAs('waiter');
    api([]);
    render(<StationBoardPage station="kitchen" />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});
