// @vitest-environment jsdom
import {
  type Reservation,
  type ReservationsFloorResponse,
  type ReservationsFloorTable,
  type SystemRole,
  systemRolePermissions,
  type WaitlistEntry,
  type WaitlistResponse,
} from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canEmail,
  messageLink,
  overHold,
  overQuoted,
  suggestTable,
  waitedMinutes,
} from '../../lib/reservations/waitlist';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { HostPage } from './host-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

// jsdom has no ResizeObserver (Radix Checkbox).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** Saturday 2027-03-06, 19:00 in Berlin (CET). */
const T = (hhmm: string) => new Date(`2027-03-06T${hhmm}:00+01:00`).toISOString();
const NOW = Date.parse(T('19:00'));
const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
  signedInAs('host');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function signedInAs(role: SystemRole, without: string[] = []) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)].filter((k) => !without.includes(k)),
    activeFeatures: ['pos', 'reservations'],
  });
}

function table(n: number, seats: number, over: Partial<ReservationsFloorTable> = {}) {
  return {
    id: id(10 + n),
    locationId: MAIN.id,
    name: `T${n}`,
    seats,
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

const FLOOR: ReservationsFloorResponse = {
  data: [
    table(1, 6),
    table(2, 4),
    table(3, 4, { state: 'occupied', occupied: true, occupiedSince: T('18:00'), covers: 2 }),
    table(4, 2),
  ],
  at: T('19:00'),
  date: '2027-03-06',
  live: true,
  timeZone: 'Europe/Berlin',
  horizonMinutes: 60,
  serviceWindows: [{ start: T('11:00'), end: T('23:00') }],
};

function entry(n: number, name: string, over: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id: id(40 + n),
    locationId: MAIN.id,
    name,
    phone: null,
    email: null,
    locale: 'en',
    partySize: 2,
    quotedMinutes: null,
    note: null,
    status: 'waiting',
    createdAt: T('18:48'),
    notifiedAt: null,
    noticeChannel: null,
    noticeResult: null,
    emailCount: 0,
    endedAt: null,
    reservationId: null,
    ...over,
  };
}

const MAILED = entry(1, 'Müller', { email: 'm@example.test' });
const PHONED = entry(2, 'Ali', { phone: '+49301234567', locale: 'de', partySize: 3 });
const LEFT = entry(9, 'Braun', { status: 'left', endedAt: T('18:30') });

const listOf = (open: WaitlistEntry[], ended: WaitlistEntry[] = []): WaitlistResponse => ({
  holdMinutes: 10,
  readyText: { en: 'Your table is ready.', de: 'Ihr Tisch ist bereit: 10 Min.' },
  open,
  ended,
});

function api(answers: Record<string, () => Response>, list = listOf([MAILED, PHONED], [LEFT])) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const reads: string[] = [];
  const base: Record<string, () => Response> = {
    'GET /api/v1/locations': () => Response.json({ data: [MAIN] }),
    'GET /api/v1/reservations/floor': () => Response.json(FLOOR),
    'GET /api/v1/reservations': () => Response.json({ data: [] }),
    'GET /api/v1/reservations/waitlist': () => Response.json(list),
    ...answers,
  };
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const [path = ''] = input.split('?');
    if (method === 'GET') reads.push(input);
    else {
      writes.push({
        method,
        path,
        body: init?.body ? (JSON.parse(init.body as string) as unknown) : null,
      });
    }
    const answer = base[`${method} ${path}`];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
  return { writes, reads };
}

const WL = '/api/v1/reservations/waitlist';
const refused = (code: string) => Response.json({ code, message: code }, { status: 409 });
const row = async (name: string) =>
  (await screen.findAllByTestId('waitlist-row')).find((r) => r.dataset.name === name)!;

describe('rules', () => {
  it('counts the wait and marks one longer than quoted', () => {
    const e = entry(1, 'A', { quotedMinutes: 10 });
    expect(waitedMinutes(e, NOW)).toBe(12);
    expect(overQuoted(e, NOW)).toBe(true);
    expect(overQuoted({ ...e, quotedMinutes: 12 }, NOW)).toBe(false);
    expect(overQuoted({ ...e, quotedMinutes: null }, NOW)).toBe(false);
    // A browser clock behind the server's never shows a negative wait.
    expect(waitedMinutes(e, Date.parse(T('18:00')))).toBe(0);
  });

  it('marks a party that was told and did not come in time', () => {
    const e = entry(1, 'A', {
      status: 'notified',
      notifiedAt: T('18:50'),
      noticeChannel: 'email',
      noticeResult: 'sent',
    });
    expect(overHold(e, NOW, 10)).toBe(true);
    expect(overHold(e, NOW, 11)).toBe(false);
    expect(overHold({ ...e, noticeResult: 'failed' }, NOW, 10)).toBe(false);
  });

  it('allows three emails, a minute apart, again at once after a failure', () => {
    const sent = entry(1, 'A', {
      email: 'a@example.test',
      status: 'notified',
      notifiedAt: new Date(NOW - 30_000).toISOString(),
      noticeChannel: 'email',
      noticeResult: 'sent',
      emailCount: 1,
    });
    expect(canEmail(sent, NOW)).toBe(false);
    expect(canEmail(sent, NOW + 30_000)).toBe(true);
    expect(canEmail({ ...sent, noticeResult: 'failed' }, NOW)).toBe(true);
    expect(canEmail({ ...sent, emailCount: 3 }, NOW + 60_000)).toBe(false);
    expect(canEmail({ ...sent, email: null }, NOW + 60_000)).toBe(false);
  });

  it('suggests the smallest free table that fits', () => {
    expect(suggestTable(FLOOR.data, 2)).toEqual([id(14)]);
    expect(suggestTable(FLOOR.data, 3)).toEqual([id(12)]);
    expect(suggestTable(FLOOR.data, 7)).toEqual([]);
  });

  it('puts the text into the message link', () => {
    expect(messageLink('+4930', 'Tisch & Platz?')).toBe('sms:+4930?body=Tisch%20%26%20Platz%3F');
  });
});

describe('the list on /host', () => {
  it('shows parties in order with their wait, contact buttons and today’s ended ones', async () => {
    const { reads } = api({});
    render(<HostPage />);
    const first = await row('Müller');
    expect(reads).toContain(`${WL}?locationId=${MAIN.id}`);
    expect(screen.getAllByTestId('waitlist-row').map((r) => r.dataset.name)).toEqual([
      'Müller',
      'Ali',
    ]);
    expect(within(first).getByTestId('waitlist-waited').textContent).toBe('waiting 12 min');
    expect(within(first).getByTestId('waitlist-email').textContent).toBe('Table ready');
    expect(within(first).queryByTestId('waitlist-call')).toBeNull();

    const second = await row('Ali');
    expect(within(second).queryByTestId('waitlist-email')).toBeNull();
    expect(within(second).getByTestId('waitlist-call').getAttribute('href')).toBe(
      'tel:+49301234567',
    );
    // In the guest's language, not the host's.
    expect(within(second).getByTestId('waitlist-message').getAttribute('href')).toBe(
      messageLink('+49301234567', 'Ihr Tisch ist bereit: 10 Min.'),
    );
    expect(screen.getByTestId('waitlist-ended-row').dataset.name).toBe('Braun');
  });

  it('says what happened to the notice', async () => {
    const told = {
      status: 'notified' as const,
      notifiedAt: T('18:55'),
      noticeChannel: 'email' as const,
      emailCount: 1,
    };
    api(
      {},
      listOf([
        entry(1, 'Sent', { ...told, noticeResult: 'sent' }),
        entry(2, 'Pending', { ...told, noticeResult: 'pending' }),
        entry(3, 'Failed', { ...told, email: 'f@example.test', noticeResult: 'failed' }),
        entry(4, 'Told', { ...told, noticeChannel: 'in_person', notifiedAt: T('18:45') }),
        entry(5, 'Long', { quotedMinutes: 5 }),
      ]),
    );
    render(<HostPage />);
    const notice = async (name: string) =>
      within(await row(name)).getByTestId('waitlist-notice').textContent;
    expect(await notice('Sent')).toBe('Emailed 18:55');
    expect(await notice('Pending')).toBe('Sending email (18:55)');
    expect(within(await row('Failed')).getByTestId('waitlist-email-failed')).toBeTruthy();
    expect(within(await row('Failed')).queryByTestId('waitlist-notice')).toBeNull();
    expect(await notice('Told')).toBe('Told 18:45');
    expect(within(await row('Told')).getByTestId('waitlist-over-hold')).toBeTruthy();
    expect(within(await row('Long')).getByTestId('waitlist-over-quoted')).toBeTruthy();
    expect(within(await row('Long')).getByTestId('waitlist-waited').textContent).toBe(
      'waiting 12 of 5 min',
    );
  });

  it('tells by email or in person, leaves and returns, and reloads each time', async () => {
    const { writes, reads } = api({
      [`POST ${WL}/${MAILED.id}/notify`]: () => Response.json(MAILED),
      [`POST ${WL}/${PHONED.id}/notify`]: () => Response.json(PHONED),
      [`POST ${WL}/${PHONED.id}/leave`]: () => Response.json(PHONED),
      [`POST ${WL}/${LEFT.id}/return`]: () => Response.json(LEFT),
    });
    render(<HostPage />);
    const loads = () => reads.filter((r) => r.startsWith(WL)).length;
    const click = async (el: HTMLElement) => {
      const before = loads();
      await userEvent.click(el);
      await waitFor(() => expect(loads()).toBeGreaterThan(before));
    };
    await click(within(await row('Müller')).getByTestId('waitlist-email'));
    await click(within(await row('Ali')).getByTestId('waitlist-told'));
    await click(within(await row('Ali')).getByTestId('waitlist-leave'));
    await click(screen.getByTestId('waitlist-return'));
    expect(writes.map((w) => [w.path.replace(WL, ''), w.body])).toEqual([
      [`/${MAILED.id}/notify`, { channel: 'email' }],
      [`/${PHONED.id}/notify`, { channel: 'in_person' }],
      [`/${PHONED.id}/leave`, {}],
      [`/${LEFT.id}/return`, {}],
    ]);
  });

  it('shows why an email was refused', async () => {
    api({
      [`POST ${WL}/${MAILED.id}/notify`]: () => refused('reservations.waitlist_notice_limit'),
    });
    render(<HostPage />);
    await userEvent.click(within(await row('Müller')).getByTestId('waitlist-email'));
    expect(await screen.findByText('This party was already emailed 3 times.')).toBeTruthy();
  });

  it('adds a party: size by one tap, a name is needed', async () => {
    const { writes } = api({ [`POST ${WL}`]: () => Response.json(MAILED) });
    render(<HostPage />);
    await userEvent.click(await screen.findByTestId('waitlist-add'));
    const dialog = await screen.findByTestId('waitlist-dialog');
    await userEvent.click(within(dialog).getByTestId('waitlist-party-5'));
    await userEvent.click(within(dialog).getByTestId('waitlist-dialog-submit'));
    expect(within(dialog).getByText('Enter a name.')).toBeTruthy();
    expect(writes).toEqual([]);

    await userEvent.type(within(dialog).getByLabelText('Name'), 'Weber');
    await userEvent.type(within(dialog).getByLabelText('Quoted wait (minutes)'), '20');
    await userEvent.type(within(dialog).getByLabelText('Phone'), '030 1234567');
    await userEvent.selectOptions(within(dialog).getByLabelText('Language'), 'de');
    await userEvent.click(within(dialog).getByTestId('waitlist-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('waitlist-dialog')).toBeNull());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: WL,
        body: {
          locationId: MAIN.id,
          name: 'Weber',
          partySize: 5,
          phone: '030 1234567',
          quotedMinutes: 20,
          locale: 'de',
        },
      },
    ]);
  });

  it('changes a party and clears what was emptied; removes after confirming', async () => {
    const { writes } = api({
      [`PATCH ${WL}/${PHONED.id}`]: () => Response.json(PHONED),
      [`DELETE ${WL}/${PHONED.id}`]: () => Response.json(PHONED),
    });
    render(<HostPage />);
    await userEvent.click(within(await row('Ali')).getByTestId('waitlist-edit'));
    let dialog = await screen.findByTestId('waitlist-dialog');
    await userEvent.clear(within(dialog).getByLabelText('Phone'));
    await userEvent.click(within(dialog).getByTestId('waitlist-dialog-submit'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      body: { name: 'Ali', partySize: 3, phone: null, email: null, note: null, locale: 'de' },
    });

    await userEvent.click(within(await row('Ali')).getByTestId('waitlist-edit'));
    dialog = await screen.findByTestId('waitlist-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove from list' }));
    expect(writes).toHaveLength(1);
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ method: 'DELETE', path: `${WL}/${PHONED.id}` });
  });

  it('seats with the party filled in and the smallest fitting table chosen', async () => {
    const reservation = { id: id(70) } as Reservation;
    const { writes } = api({
      [`POST ${WL}/${PHONED.id}/seat`]: () =>
        writes.length === 1
          ? refused('reservations.table_occupied')
          : Response.json({ entry: PHONED, reservation }),
    });
    render(<HostPage />);
    await userEvent.click(within(await row('Ali')).getByTestId('waitlist-seat'));
    const dialog = await screen.findByTestId('walk-in-dialog');
    expect(within(dialog).getByText('Seat Ali')).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Party size').value).toBe('3');
    // The booking gets the entry's name and contacts.
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    await userEvent.click(within(dialog).getByTestId('walk-in-dialog-submit'));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(writes[0]).toEqual({
      method: 'POST',
      path: `${WL}/${PHONED.id}/seat`,
      body: { partySize: 3, tableIds: [id(12)] },
    });
  });

  it('shows the list without buttons to someone who may only read', async () => {
    signedInAs('host', [
      'reservations.waitlist.create',
      'reservations.waitlist.edit',
      'reservations.waitlist.delete',
    ]);
    api({});
    render(<HostPage />);
    const first = await row('Müller');
    expect(within(first).queryByRole('button')).toBeNull();
    expect(within(first).queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('waitlist-add')).toBeNull();
    expect(screen.queryByTestId('waitlist-return')).toBeNull();
  });

  it('keeps the floor usable when the list can’t be loaded, and hides it on other days', async () => {
    const { reads } = api({
      [`GET ${WL}`]: () => Response.json({ code: 'x', message: 'x' }, { status: 500 }),
    });
    render(<HostPage />);
    const panel = await screen.findByTestId('waitlist');
    expect(await within(panel).findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getAllByTestId('host-table')).toHaveLength(4);

    const before = reads.filter((r) => r.startsWith(WL)).length;
    const tomorrow = { ...FLOOR, live: false, date: '2027-03-07' as const };
    const current = mockState.store.apiFetch.getMockImplementation()!;
    mockState.store.apiFetch.mockImplementation((input, init) =>
      input.includes('/floor?') ? Promise.resolve(Response.json(tomorrow)) : current(input, init),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(screen.queryByTestId('waitlist')).toBeNull());
    expect(reads.filter((r) => r.startsWith(WL))).toHaveLength(before);
  });
});
