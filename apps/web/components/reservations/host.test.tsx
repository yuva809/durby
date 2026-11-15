// @vitest-environment jsdom
import {
  type Reservation,
  type ReservationsFloorResponse,
  type ReservationsFloorTable,
  type SystemRole,
  systemRolePermissions,
} from '@durby/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { HOST_REFRESH_MS, HostPage } from './host-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

// jsdom has no ResizeObserver (Radix Checkbox) nor pointer capture (Radix DropdownMenu).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  scrollIntoView: () => undefined,
});

/** Saturday 2027-03-06, 19:00 in Berlin (CET). */
const T = (hhmm: string, date = '2027-03-06') => new Date(`${date}T${hhmm}:00+01:00`).toISOString();
const NOW = T('19:00');

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['pos', 'reservations'],
  });
}

function table(n: number, name: string, over: Partial<ReservationsFloorTable> = {}) {
  return {
    id: id(10 + n),
    locationId: MAIN.id,
    name,
    seats: 4,
    areaId: null,
    area: null,
    shape: 'square',
    color: 'neutral',
    sortOrder: n,
    state: 'free',
    overrun: false,
    walkInOnly: false,
    current: null,
    next: null,
    occupied: false,
    occupiedSince: null,
    covers: null,
    ...over,
  } satisfies ReservationsFloorTable;
}

function booking(n: number, name: string, over: Partial<Reservation> = {}): Reservation {
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
    guest: { id: id(60 + n), name, email: null, phone: null, locale: 'en', anonymisedAt: null },
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

const WEBER = booking(1, 'Weber'); // T2, 19:30
const KLEIN = booking(2, 'Klein', {
  status: 'seated',
  startsAt: T('18:55'),
  endsAt: T('20:25'),
  tableIds: [id(13)],
  lastChangeId: id(82),
  lastChange: {
    id: id(82),
    fromStatus: 'booked',
    toStatus: 'seated',
    undoesId: null,
    actorKind: 'system',
    sourceOrderId: id(99),
    createdAt: T('18:58'),
  },
});
// Late (18:50), on T4 where a till order overruns.
const SCHMIDT = booking(3, 'Schmidt', { startsAt: T('18:50'), tableIds: [id(14)] });
const ALI = booking(4, 'Ali', {
  startsAt: T('21:00'),
  endsAt: T('22:30'),
  tableIds: [id(19)],
  tablesNotInService: [id(19)],
});
const DAY = [KLEIN, SCHMIDT, WEBER, ALI];

const FLOOR: ReservationsFloorResponse = {
  data: [
    table(1, 'T1', {
      state: 'occupied',
      occupied: true,
      occupiedSince: T('18:20'),
      covers: 3,
      current: {
        reservationId: null,
        partySize: 3,
        guestName: null,
        since: T('18:20'),
        until: T('20:20'),
      },
    }),
    table(2, 'T2', {
      state: 'reserved_soon',
      next: {
        reservationId: WEBER.id,
        startsAt: WEBER.startsAt,
        partySize: 2,
        guestName: 'Weber',
        tableStillOccupied: false,
      },
    }),
    table(3, 'T3', {
      state: 'occupied',
      occupied: true,
      occupiedSince: T('18:55'),
      covers: 2,
      current: {
        reservationId: KLEIN.id,
        partySize: 2,
        guestName: 'Klein',
        since: T('18:55'),
        until: T('20:25'),
      },
    }),
    table(4, 'T4', {
      state: 'occupied',
      overrun: true,
      occupied: true,
      current: {
        reservationId: null,
        partySize: 2,
        guestName: null,
        since: T('17:00'),
        until: T('19:30'),
      },
      next: {
        reservationId: SCHMIDT.id,
        startsAt: SCHMIDT.startsAt,
        partySize: 2,
        guestName: 'Schmidt',
        tableStillOccupied: true,
      },
    }),
    table(5, 'W5', { walkInOnly: true }),
  ],
  at: NOW,
  date: '2027-03-06',
  live: true,
  timeZone: 'Europe/Berlin',
  horizonMinutes: 60,
  serviceWindows: [{ start: T('11:00'), end: T('23:00') }],
};

type Answer = (query: URLSearchParams, body: unknown) => Response;

/** Answers by `METHOD path`; records reads and writes (with their Idempotency-Key). */
function api(answers: Record<string, Answer>) {
  const writes: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const reads: string[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const [path = '', search = ''] = input.split('?');
    const body: unknown = init?.body ? JSON.parse(init.body as string) : null;
    if (method === 'GET') reads.push(input);
    else
      writes.push({
        method,
        path,
        body,
        key: new Headers(init?.headers).get('Idempotency-Key'),
      });
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(
      answer ? answer(new URLSearchParams(search), body) : Response.json({ data: [] }),
    );
  });
  return { writes, reads };
}

const BASE: Record<string, Answer> = {
  'GET /api/v1/locations': () => Response.json({ data: [MAIN] }),
  'GET /api/v1/reservations/floor': () => Response.json(FLOOR),
  'GET /api/v1/reservations': () => Response.json({ data: DAY }),
};
const refused = (code: string, status = 409) => Response.json({ code, message: code }, { status });

const rowOf = async (guest: string) =>
  (await screen.findAllByTestId('timeline-row')).find((r) => r.dataset.guest === guest)!;
const tileOf = (name: string) =>
  screen.getAllByTestId('host-table').find((r) => r.dataset.name === name)!;

describe('/host access', () => {
  it('needs reservations.bookings.read', () => {
    signedInAs('cashier');
    render(<HostPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('shows a waiter the day without write buttons only when they lack the manage key', async () => {
    mockState.session = sessionFixture({
      activePermissions: ['reservations.bookings.read'],
      activeFeatures: ['reservations'],
    });
    api(BASE);
    render(<HostPage />);
    await rowOf('Weber');
    expect(screen.queryByTestId('host-new-booking')).toBeNull();
    expect(screen.queryByTestId('row-arrive')).toBeNull();
  });
});

describe('today (live)', () => {
  beforeEach(() => signedInAs('host'));

  it('loads the floor now and the day of its date, with counts, rows and table states', async () => {
    const { reads } = api(BASE);
    render(<HostPage />);
    const weber = await rowOf('Weber');
    expect(reads).toContain(`/api/v1/reservations/floor?locationId=${MAIN.id}`);
    expect(reads).toContain(`/api/v1/reservations?locationId=${MAIN.id}&date=2027-03-06`);
    // Covers of blocking bookings (2 + 2 + 2 + 2), booked (3), seated (1).
    expect(screen.getByTestId('host-counts').textContent).toBe('Covers 8 · Booked 3 · Seated 1');
    expect(within(weber).getByText('19:30')).toBeTruthy();
    expect(within(weber).getByText('T2')).toBeTruthy();
    expect(within(weber).getByTestId('row-status').textContent).toBe('Booked');
    // Not started yet: no no-show.
    expect(within(weber).queryByTestId('row-no-show')).toBeNull();
    expect(within(await rowOf('Schmidt')).getByTestId('row-no-show')).toBeTruthy();
    expect(screen.getAllByTestId('host-table').map((x) => x.dataset.state)).toEqual([
      'occupied',
      'reserved_soon',
      'occupied',
      'occupied',
      'free',
    ]);
    expect(within(tileOf('T1')).getByText('Order at the till')).toBeTruthy();
    expect(within(tileOf('T2')).getByTestId('tile-next').textContent).toBe(
      'Next 19:30 · Weber · 2 p.',
    );
    expect(within(tileOf('T4')).getByTestId('tile-overrun')).toBeTruthy();
    expect(within(tileOf('W5')).getByText('Walk-ins only')).toBeTruthy();
    expect(screen.queryByTestId('host-plan-note')).toBeNull();
  });

  it('marks the auto-seated booking and undoes it while the window lasts', async () => {
    const { writes } = api({
      ...BASE,
      [`POST /api/v1/reservations/${KLEIN.id}/undo`]: () =>
        Response.json({
          ...KLEIN,
          status: 'booked',
          lastChange: {
            ...KLEIN.lastChange,
            id: id(83),
            fromStatus: 'seated',
            toStatus: 'booked',
            undoesId: id(82),
          },
        }),
    });
    render(<HostPage />);
    const klein = await rowOf('Klein');
    expect(within(klein).getByTestId('till-badge').textContent).toBe('Auto-seated from till');
    // Changed at 18:58: 3 minutes left at 19:00.
    const undo = within(klein).getByTestId('row-undo');
    expect(undo.textContent).toBe('Undo (3 min)');
    // A user's change gets no badge and no row undo.
    expect(within(await rowOf('Weber')).queryByTestId('till-badge')).toBeNull();
    await userEvent.click(undo);
    await waitFor(() =>
      expect(writes).toEqual([
        expect.objectContaining({
          path: `/api/v1/reservations/${KLEIN.id}/undo`,
          body: { changeId: id(82) },
        }),
      ]),
    );
  });

  it('flags a booking whose table was archived and moves it with Change tables', async () => {
    const { writes } = api({
      ...BASE,
      [`PATCH /api/v1/reservations/${ALI.id}`]: (_, body) =>
        Response.json({ ...ALI, ...(body as object), tablesNotInService: [] }),
    });
    render(<HostPage />);
    const ali = await rowOf('Ali');
    expect(within(ali).getByTestId('row-flag').textContent).toBe(
      'Table not in service, move booking',
    );
    expect(within(ali).getByText('Table not in service')).toBeTruthy(); // its table's name is gone
    await userEvent.click(within(ali).getByTestId('row-change-tables'));
    const dialog = await screen.findByTestId('tables-dialog');
    // Walk-in-only tables aren't offered for a booking.
    expect(within(dialog).queryByText('W5 (4 seats)')).toBeNull();
    await userEvent.click(within(dialog).getByText('T2 (4 seats)'));
    await userEvent.click(within(dialog).getByTestId('tables-dialog-submit'));
    await waitFor(() =>
      expect(writes).toEqual([
        expect.objectContaining({
          method: 'PATCH',
          path: `/api/v1/reservations/${ALI.id}`,
          body: { tableIds: [id(12)] },
        }),
      ]),
    );
  });

  it('flags the booking due on a table that is still occupied', async () => {
    api(BASE);
    render(<HostPage />);
    const schmidt = await rowOf('Schmidt');
    expect(within(schmidt).getByTestId('row-flag').textContent).toBe('Table still occupied');
    expect(within(schmidt).getByTestId('row-change-tables')).toBeTruthy();
    expect(within(tileOf('T4')).getByText('Table still occupied')).toBeTruthy();
  });

  it('seats at other tables when its own table was archived since (409)', async () => {
    const { writes } = api({
      ...BASE,
      [`POST /api/v1/reservations/${WEBER.id}/seat`]: (_, body) =>
        (body as { tableIds?: string[] }).tableIds
          ? Response.json({ ...WEBER, status: 'seated', tableIds: [id(15)] })
          : refused('reservations.table_not_in_service'),
    });
    render(<HostPage />);
    await userEvent.click(within(await rowOf('Weber')).getByTestId('row-seat'));
    const dialog = await screen.findByTestId('tables-dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('Seat Weber at');
    await userEvent.click(within(dialog).getByText('T3 (4 seats)'));
    await userEvent.click(within(dialog).getByTestId('tables-dialog-submit'));
    await waitFor(() => expect(writes.at(-1)?.body).toEqual({ tableIds: [id(12), id(13)] }));
  });

  it('arrives a guest, shows the undo bar and undoes from it', async () => {
    const arrived = {
      ...WEBER,
      status: 'arrived' as const,
      lastChangeId: id(84),
      lastChange: {
        ...WEBER.lastChange,
        id: id(84),
        fromStatus: 'booked' as const,
        toStatus: 'arrived' as const,
        createdAt: NOW,
      },
    };
    const { writes, reads } = api({
      ...BASE,
      [`POST /api/v1/reservations/${WEBER.id}/arrive`]: () => Response.json(arrived),
      [`POST /api/v1/reservations/${WEBER.id}/undo`]: () =>
        Response.json({
          ...WEBER,
          lastChange: { ...arrived.lastChange, id: id(85), undoesId: id(84) },
        }),
    });
    render(<HostPage />);
    const weber = await rowOf('Weber');
    const before = reads.length;
    await userEvent.click(within(weber).getByTestId('row-arrive'));
    const bar = await screen.findByTestId('undo-bar');
    expect(bar.textContent).toContain('Weber: Arrived');
    await waitFor(() => expect(reads.length).toBeGreaterThan(before)); // reloaded after the action
    await userEvent.click(within(bar).getByTestId('undo-bar-undo'));
    await waitFor(() =>
      expect(writes.at(-1)).toMatchObject({
        path: `/api/v1/reservations/${WEBER.id}/undo`,
        body: { changeId: id(84) },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('undo-bar')).toBeNull());
  });

  it('cancels only after confirming', async () => {
    const { writes } = api({
      ...BASE,
      [`POST /api/v1/reservations/${WEBER.id}/cancel`]: () =>
        Response.json({ ...WEBER, status: 'cancelled' }),
    });
    render(<HostPage />);
    await userEvent.click(within(await rowOf('Weber')).getByTestId('row-cancel'));
    expect(writes).toEqual([]);
    expect(await screen.findByText('Cancel the booking of Weber?')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() =>
      expect(writes.map((w) => w.path)).toEqual([`/api/v1/reservations/${WEBER.id}/cancel`]),
    );
  });

  it('books by phone; pacing refused → Book anyway sends force', async () => {
    let calls = 0;
    const { writes } = api({
      ...BASE,
      'POST /api/v1/reservations': () =>
        ++calls === 1
          ? refused('reservations.pacing_exceeded')
          : Response.json({ ...WEBER, id: id(49) }, { status: 201 }),
    });
    render(<HostPage />);
    await userEvent.click(await screen.findByTestId('host-new-booking'));
    const dialog = await screen.findByTestId('booking-dialog');
    // Today: the next quarter hour.
    expect(within(dialog).getByLabelText<HTMLInputElement>('Time').value).toBe('19:00');
    await userEvent.clear(within(dialog).getByLabelText('Time'));
    await userEvent.type(within(dialog).getByLabelText('Time'), '20:15');
    await userEvent.clear(within(dialog).getByLabelText('Party size'));
    await userEvent.type(within(dialog).getByLabelText('Party size'), '4');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Müller');
    await userEvent.type(within(dialog).getByLabelText('Phone'), '030 1234567');
    await userEvent.type(within(dialog).getByLabelText("Guest's note"), 'Window seat');
    await userEvent.click(within(dialog).getByTestId('booking-dialog-submit'));
    expect((await within(dialog).findByRole('alert')).textContent).toBeTruthy();
    await within(dialog).findByTestId('booking-force');
    expect(writes[0]).toMatchObject({
      path: '/api/v1/reservations',
      body: {
        locationId: MAIN.id,
        startsAt: T('20:15'),
        partySize: 4,
        guest: { name: 'Müller', phone: '030 1234567' },
        guestNote: 'Window seat',
      },
    });
    expect(writes[0]!.body).not.toHaveProperty('tableIds');
    expect(writes[0]!.body).not.toHaveProperty('force');
    await userEvent.click(within(dialog).getByTestId('booking-force'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toMatchObject({ force: true, startsAt: T('20:15') });
    // Another request: another Idempotency-Key.
    expect(writes[1]!.key).not.toBe(writes[0]!.key);
    await waitFor(() => expect(screen.queryByTestId('booking-dialog')).toBeNull());
  });

  it('shows other refusals without Book anyway', async () => {
    api({ ...BASE, 'POST /api/v1/reservations': () => refused('reservations.table_unavailable') });
    render(<HostPage />);
    await userEvent.click(await screen.findByTestId('host-new-booking'));
    const dialog = await screen.findByTestId('booking-dialog');
    await userEvent.click(within(dialog).getByTestId('booking-dialog-submit'));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).queryByTestId('booking-force')).toBeNull();
  });

  it('seats a walk-in from a free table; a collision offers Seat until the next booking', async () => {
    let calls = 0;
    const { writes } = api({
      ...BASE,
      'POST /api/v1/reservations/walk-ins': () =>
        ++calls === 1
          ? refused('reservations.table_unavailable')
          : Response.json({ ...WEBER, source: 'walk_in', status: 'seated' }, { status: 201 }),
    });
    render(<HostPage />);
    await rowOf('Weber');
    await userEvent.click(within(tileOf('T2')).getByRole('button'));
    await userEvent.click(await screen.findByTestId('tile-walk-in'));
    const dialog = await screen.findByTestId('walk-in-dialog');
    await userEvent.click(within(dialog).getByTestId('walk-in-dialog-submit'));
    expect(writes[0]?.body).toEqual({ locationId: MAIN.id, partySize: 2, tableIds: [id(12)] });
    const until = await within(dialog).findByTestId('walk-in-until');
    expect(until.textContent).toBe('Seat until 19:30');
    await userEvent.click(until);
    await waitFor(() => expect(writes[1]?.body).toMatchObject({ endsAt: T('19:30') }));
  });

  it('seats the next booking from its table', async () => {
    const { writes } = api({
      ...BASE,
      [`POST /api/v1/reservations/${WEBER.id}/seat`]: () =>
        Response.json({ ...WEBER, status: 'seated' }),
    });
    render(<HostPage />);
    await rowOf('Weber');
    await userEvent.click(within(tileOf('T2')).getByRole('button'));
    await userEvent.click(await screen.findByTestId('tile-seat-next'));
    await waitFor(() =>
      expect(writes.map((w) => w.path)).toEqual([`/api/v1/reservations/${WEBER.id}/seat`]),
    );
  });

  it('refreshes every 30 s while visible', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date(NOW), shouldAdvanceTime: true });
    const { reads } = api(BASE);
    render(<HostPage />);
    await rowOf('Weber');
    const floors = () => reads.filter((r) => r.includes('/floor')).length;
    const before = floors();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_REFRESH_MS);
    });
    await waitFor(() => expect(floors()).toBe(before + 1));
  });

  it("reloads on the reservations stream's hints, without waiting for the 30 s poll", async () => {
    let push: (text: string) => void = () => undefined;
    const stream = () => {
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          push = (text) => c.enqueue(new TextEncoder().encode(text));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const { reads } = api({ ...BASE, 'GET /api/v1/reservations/stream': stream });
    render(<HostPage />);
    await rowOf('Weber');
    expect(reads).toContain(`/api/v1/reservations/stream?locationId=${MAIN.id}`);
    const floors = () => reads.filter((r) => r.includes('/floor')).length;
    await waitFor(() => expect(floors()).toBeGreaterThan(0));
    push('event: ready\ndata: {"heartbeatMs":15000,"expiresAt":"2027-03-06T18:10:00.000Z"}\n\n');
    // `ready` reloads once (changes while connecting), then each hint does.
    await waitFor(() => expect(floors()).toBe(2));
    push(`event: changed\ndata: {"topic":"reservations","ids":["${WEBER.id}"]}\n\n`);
    await waitFor(() => expect(floors()).toBe(3));
  });
});

describe('another day (plan)', () => {
  beforeEach(() => signedInAs('host'));

  const SUNDAY: ReservationsFloorResponse = {
    ...FLOOR,
    data: FLOOR.data.map((x) => ({
      ...x,
      state: 'free',
      current: null,
      next: null,
      overrun: false,
      occupied: false,
    })),
    at: T('11:00', '2027-03-07'),
    date: '2027-03-07',
    live: false,
    serviceWindows: [{ start: T('11:00', '2027-03-07'), end: T('12:00', '2027-03-07') }],
  };

  it('shows bookings only, from the first service window, with a time selector and no floor actions', async () => {
    const { reads } = api({
      ...BASE,
      'GET /api/v1/reservations/floor': (q) =>
        Response.json(
          q.has('date') || q.has('at') ? { ...SUNDAY, at: q.get('at') ?? SUNDAY.at } : FLOOR,
        ),
      'GET /api/v1/reservations': (q) =>
        Response.json({
          data:
            q.get('date') === '2027-03-07'
              ? [booking(5, 'Sunday', { startsAt: T('11:30', '2027-03-07') })]
              : DAY,
        }),
    });
    render(<HostPage />);
    await rowOf('Weber');
    await userEvent.click(screen.getByRole('button', { name: 'Next day' }));
    const sunday = await rowOf('Sunday');
    expect(reads).toContain(`/api/v1/reservations/floor?locationId=${MAIN.id}&date=2027-03-07`);
    expect(reads).toContain(`/api/v1/reservations?locationId=${MAIN.id}&date=2027-03-07`);
    expect(screen.getByTestId('host-plan-note')).toBeTruthy();
    expect(screen.getByText('Floor at 11:00')).toBeTruthy();
    const time = screen.getByTestId<HTMLSelectElement>('host-time');
    expect([...time.options].map((o) => o.text)).toEqual(['11:00', '11:15', '11:30', '11:45']);
    // A plan: no walk-ins, no seating, no arrival; cancelling stays possible.
    expect(screen.queryByTestId('host-new-walk-in')).toBeNull();
    expect(screen.getByTestId('host-new-booking')).toBeTruthy();
    expect(within(sunday).queryByTestId('row-arrive')).toBeNull();
    expect(within(sunday).queryByTestId('row-seat')).toBeNull();
    expect(within(sunday).getByTestId('row-cancel')).toBeTruthy();
    expect(within(tileOf('T2')).queryByRole('button')).toBeNull();

    await userEvent.selectOptions(time, T('11:30', '2027-03-07'));
    await waitFor(() =>
      expect(reads).toContain(
        `/api/v1/reservations/floor?${new URLSearchParams({ locationId: MAIN.id, at: T('11:30', '2027-03-07') })}`,
      ),
    );
    // A booking made from the plan starts at the chosen day and time.
    await userEvent.click(screen.getByTestId('host-new-booking'));
    const dialog = await screen.findByTestId('booking-dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Date').value).toBe('2027-03-07');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Time').value).toBe('11:30');

    // Back to today: live again.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await rowOf('Weber');
    expect(screen.queryByTestId('host-plan-note')).toBeNull();
  });
});
