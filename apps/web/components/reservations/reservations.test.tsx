// @vitest-environment jsdom
import {
  type Reservation,
  type ReservationsFloorResponse,
  type SystemRole,
  systemRolePermissions,
} from '@durby/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { ReservationsPage } from './reservations-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  scrollIntoView: () => undefined,
});

/** Saturday 2027-03-06, 17:00 in Berlin (CET). */
const T = (hhmm: string, date = '2027-03-06') => new Date(`${date}T${hhmm}:00+01:00`).toISOString();
const NOW = T('17:00');

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['pos', 'reservations'],
  });
}

const table = (n: number, name: string) => ({
  id: id(10 + n),
  locationId: MAIN.id,
  name,
  seats: 4,
  areaId: null,
  area: null,
  shape: 'square' as const,
  color: 'neutral' as const,
  sortOrder: n,
  state: 'free' as const,
  overrun: false,
  walkInOnly: false,
  current: null,
  next: null,
  occupied: false,
  occupiedSince: null,
  covers: null,
});

const FLOOR: ReservationsFloorResponse = {
  data: [table(2, 'T2'), table(4, 'T4'), table(6, 'T6')],
  at: NOW,
  date: '2027-03-06',
  live: true,
  timeZone: 'Europe/Berlin',
  horizonMinutes: 60,
  serviceWindows: [{ start: T('11:00'), end: T('23:00') }],
};

function booking(n: number, name: string | null, over: Partial<Reservation> = {}): Reservation {
  return {
    id: id(40 + n),
    number: `RES-2027-00000${n}`,
    locationId: MAIN.id,
    status: 'booked',
    source: 'staff',
    partySize: 2,
    startsAt: T('19:30'),
    endsAt: T('21:00'),
    tableIds: [id(12)],
    guest: {
      id: id(60 + n),
      name,
      email: null,
      phone: '+49301234567',
      locale: 'en',
      anonymisedAt: null,
    },
    guestNote: null,
    staffNote: null,
    createdAt: T('12:00'),
    lastChangeId: id(70 + n),
    lastChange: {
      id: id(70 + n),
      fromStatus: null,
      toStatus: 'booked',
      undoesId: null,
      actorKind: 'user',
      sourceOrderId: null,
      createdAt: T('12:00'),
    },
    tablesNotInService: [],
    ...over,
  };
}

const WEBER = booking(1, 'Weber');
const KLEIN = booking(2, 'Klein', { startsAt: T('20:00', '2027-03-07'), tableIds: [id(14)] });
const DONE = booking(3, 'Braun', { status: 'finished', startsAt: T('12:00') });
const ERASED = booking(4, null, {
  guest: {
    id: id(64),
    name: null,
    email: null,
    phone: null,
    locale: 'en',
    anonymisedAt: T('16:00'),
  },
});

type Answer = (query: URLSearchParams, body: unknown) => Response;

function api(answers: Record<string, Answer>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const reads: string[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const [path = '', search = ''] = input.split('?');
    const body: unknown = init?.body ? JSON.parse(init.body as string) : null;
    if (method === 'GET') reads.push(input);
    else writes.push({ method, path, body });
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(
      answer ? answer(new URLSearchParams(search), body) : Response.json({ data: [] }),
    );
  });
  return { writes, reads };
}

const AVAILABILITY = {
  date: '2027-03-06',
  turnMinutes: 90,
  closed: false,
  slots: [
    { start: T('19:45'), end: T('21:15'), status: 'full', reason: 'no_table' },
    {
      start: T('20:00'),
      end: T('21:30'),
      status: 'available',
      allocation: { kind: 'table', tableId: id(16) },
    },
  ],
};

const BASE: Record<string, Answer> = {
  'GET /api/v1/locations': () => Response.json({ data: [MAIN] }),
  'GET /api/v1/reservations/floor': () => Response.json(FLOOR),
  'GET /api/v1/reservations': () => Response.json({ data: [DONE, WEBER, ERASED] }),
  'GET /api/v1/reservations/availability': () => Response.json(AVAILABILITY),
};

const rowOf = async (number: string) =>
  (await screen.findAllByTestId('list-row')).find((r) => r.dataset.number === number)!;

describe('/reservations', () => {
  it('needs reservations.bookings.read', () => {
    signedInAs('cashier');
    render(<ReservationsPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it("lists the location's today and searches by name, phone or number", async () => {
    signedInAs('host');
    const { reads } = api(BASE);
    render(<ReservationsPage />);
    await rowOf(WEBER.number);
    // One request for the range: the location's day in its time zone.
    expect(reads.find((r) => r.startsWith('/api/v1/reservations?'))).toContain(
      `from=${encodeURIComponent(new Date('2027-03-06T00:00:00+01:00').toISOString())}`,
    );
    expect(screen.getAllByTestId('list-row')).toHaveLength(3);
    expect((await rowOf(ERASED.number)).textContent).toContain('Guest data erased');
    // Finished bookings can't be edited or cancelled.
    expect(within(await rowOf(DONE.number)).queryByTestId('list-edit')).toBeNull();

    await userEvent.type(screen.getByTestId('list-search'), 'weber');
    expect(screen.getAllByTestId('list-row').map((r) => r.dataset.number)).toEqual([WEBER.number]);
    await userEvent.clear(screen.getByTestId('list-search'));
    await userEvent.type(screen.getByTestId('list-search'), '000003');
    expect(screen.getAllByTestId('list-row').map((r) => r.dataset.number)).toEqual([DONE.number]);
    await userEvent.clear(screen.getByTestId('list-search'));
    await userEvent.type(screen.getByTestId('list-search'), '1234567');
    expect(screen.getAllByTestId('list-row')).toHaveLength(2);
  });

  it('loads a longer range in one request and refuses more than 31 days', async () => {
    signedInAs('host');
    const { reads } = api({
      ...BASE,
      'GET /api/v1/reservations': () => Response.json({ data: [WEBER, KLEIN] }),
    });
    render(<ReservationsPage />);
    await rowOf(WEBER.number);
    const to = screen.getByTestId('list-to');
    fireEvent.change(to, { target: { value: '2027-03-08' } });
    await waitFor(() =>
      expect(reads.at(-1)).toContain(
        `to=${encodeURIComponent(new Date('2027-03-09T00:00:00+01:00').toISOString())}`,
      ),
    );
    expect(await rowOf(KLEIN.number)).toBeTruthy();

    const before = reads.length;
    fireEvent.change(to, { target: { value: '2027-04-30' } });
    expect(await screen.findByTestId('list-range-invalid')).toBeTruthy();
    expect(reads.slice(before).filter((r) => r.startsWith('/api/v1/reservations?'))).toEqual([]);
  });

  it('shows a reader the list without Edit, Cancel or + Booking', async () => {
    mockState.session = sessionFixture({
      activePermissions: ['reservations.bookings.read'],
      activeFeatures: ['reservations'],
    });
    api(BASE);
    render(<ReservationsPage />);
    const row = await rowOf(WEBER.number);
    expect(within(row).queryByTestId('list-edit')).toBeNull();
    expect(within(row).queryByTestId('list-cancel')).toBeNull();
    expect(screen.queryByTestId('list-new-booking')).toBeNull();
  });

  it('edits a booking: a free time moves it to the table the system picks, only changes are sent', async () => {
    signedInAs('host');
    const { writes, reads } = api({
      ...BASE,
      [`PATCH /api/v1/reservations/${WEBER.id}`]: () => Response.json(WEBER),
    });
    render(<ReservationsPage />);
    await userEvent.click(within(await rowOf(WEBER.number)).getByTestId('list-edit'));
    const dialog = await screen.findByTestId('booking-dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Time').value).toBe('19:30');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('Weber');
    // Moving a booking: it doesn't block itself.
    await waitFor(() =>
      expect(reads.some((r) => r.includes(`excludeReservationId=${WEBER.id}`))).toBe(true),
    );
    const slots = await within(dialog).findAllByTestId('booking-slot');
    expect(slots.map((s) => s.textContent)).toEqual(['20:00']);
    await userEvent.click(slots[0]!);
    expect(within(dialog).getByTestId('booking-tables-summary').textContent).toContain('T6');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'weber@example.test');
    // Host has no reservations.setup.manage: no erase.
    expect(within(dialog).queryByTestId('booking-erase')).toBeNull();
    await userEvent.click(within(dialog).getByTestId('booking-dialog-submit'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PATCH',
      path: `/api/v1/reservations/${WEBER.id}`,
      body: {
        startsAt: T('20:00'),
        tableIds: [id(16)],
        guest: { email: 'weber@example.test' },
      },
    });
    await waitFor(() => expect(screen.queryByTestId('booking-dialog')).toBeNull());
  });

  it('books from a free time with the chosen tables, or tables picked by hand', async () => {
    signedInAs('host');
    const { writes } = api({
      ...BASE,
      'POST /api/v1/reservations': () => Response.json(WEBER, { status: 201 }),
    });
    render(<ReservationsPage />);
    await userEvent.click(await screen.findByTestId('list-new-booking'));
    const dialog = await screen.findByTestId('booking-dialog');
    await userEvent.click((await within(dialog).findAllByTestId('booking-slot'))[0]!);
    await userEvent.click(within(dialog).getByTestId('booking-choose-tables'));
    await userEvent.click(within(dialog).getByLabelText(/^T4/));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Ada');
    await userEvent.click(within(dialog).getByTestId('booking-dialog-submit'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      startsAt: T('20:00'),
      tableIds: [id(16), id(14)],
      guest: { name: 'Ada' },
    });
  });

  it('cancels after confirming', async () => {
    signedInAs('host');
    const { writes } = api({
      ...BASE,
      [`POST /api/v1/reservations/${WEBER.id}/cancel`]: () =>
        Response.json({ ...WEBER, status: 'cancelled' }, { status: 201 }),
    });
    render(<ReservationsPage />);
    await userEvent.click(within(await rowOf(WEBER.number)).getByTestId('list-cancel'));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() =>
      expect(writes).toEqual([
        { method: 'POST', path: `/api/v1/reservations/${WEBER.id}/cancel`, body: {} },
      ]),
    );
  });

  it("lets a manager erase the guest's data after a confirm that says it can't be undone", async () => {
    signedInAs('manager');
    const { writes } = api({
      ...BASE,
      [`POST /api/v1/reservations/guests/${WEBER.guest.id}/anonymise`]: () =>
        Response.json({ id: WEBER.guest.id, anonymisedAt: NOW }, { status: 201 }),
    });
    render(<ReservationsPage />);
    await userEvent.click(within(await rowOf(WEBER.number)).getByTestId('list-edit'));
    const dialog = await screen.findByTestId('booking-dialog');
    await userEvent.click(within(dialog).getByTestId('booking-erase'));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain("can't be undone");
    expect(writes).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Erase guest data' }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: 'POST',
          path: `/api/v1/reservations/guests/${WEBER.guest.id}/anonymise`,
          body: {},
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId('booking-dialog')).toBeNull());
  });

  it('offers no erase for a guest already erased, and says details go to a new guest', async () => {
    signedInAs('manager');
    api(BASE);
    render(<ReservationsPage />);
    await userEvent.click(within(await rowOf(ERASED.number)).getByTestId('list-edit'));
    const dialog = await screen.findByTestId('booking-dialog');
    expect(within(dialog).getByTestId('booking-erased')).toBeTruthy();
    expect(within(dialog).queryByTestId('booking-erase')).toBeNull();
  });
});
