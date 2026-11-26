// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { ReservationsSetupPage } from './reservations-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };
const HARBOUR = { id: id(2), name: 'Harbour', brandId: id(90) };
const table = (n: number, name: string, seats: number, extra: object = {}) => ({
  id: id(10 + n),
  locationId: MAIN.id,
  name,
  seats,
  areaId: null,
  area: null,
  sortOrder: n,
  bookingMode: 'all',
  minParty: 1,
  maxParty: null,
  ...extra,
});
const T2 = table(1, 'T2', 2);
const T4 = table(2, 'T4', 4);
const T6 = table(3, 'T6', 6, { minParty: 4 });
const PIER = { ...table(4, 'Pier 1', 4), locationId: HARBOUR.id };
const COMBO = {
  id: id(30),
  locationId: MAIN.id,
  name: 'T4+T6',
  tableIds: [T4.id, T6.id],
  minParty: 7,
  maxParty: 10,
  onlineBookable: true,
  archivedAt: null,
};
const OLD_COMBO = {
  ...COMBO,
  id: id(31),
  name: 'Old',
  tableIds: [T2.id, T4.id],
  archivedAt: '2026-10-01T10:00:00.000Z',
};

function signedInAs(role: SystemRole, features: string[] = ['pos', 'reservations']) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: features,
  });
}

/** Answers by `METHOD path` (query ignored, but kept in `reads`); records writes. */
function api(answers: Record<string, (query: URLSearchParams) => Response>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const reads: string[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const [path = '', search = ''] = input.split('?');
    if (method === 'GET') reads.push(input);
    else writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : null });
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(
      answer ? answer(new URLSearchParams(search)) : Response.json({ data: [] }),
    );
  });
  return { writes, reads };
}

const OPEN_SAT = {
  mon: [{ from: '11:00', to: '23:00' }],
  tue: [{ from: '11:00', to: '23:00' }],
  wed: [{ from: '11:00', to: '23:00' }],
  thu: [{ from: '11:00', to: '23:00' }],
  fri: [{ from: '11:00', to: '23:00' }],
  sat: [{ from: '11:00', to: '23:00' }],
  sun: [{ from: '11:00', to: '23:00' }],
};
const setting = (key: string, value: unknown, source = 'default') => ({
  key,
  value,
  source,
  dataBound: false,
});
const LOCATION_SETTINGS = {
  data: [
    setting(
      'reservations.serviceHours',
      {
        ...OPEN_SAT,
        sat: [{ from: '10:00', to: '23:30' }],
      },
      'location',
    ),
    setting('reservations.slotIntervalMinutes', 15, 'organization'),
    setting('reservations.holdMinutes', 5),
  ],
  openingHours: OPEN_SAT,
};

const answers = {
  'GET /api/v1/locations': () => Response.json({ data: [MAIN, HARBOUR] }),
  'GET /api/v1/reservations/settings': () => Response.json(LOCATION_SETTINGS),
  'GET /api/v1/reservations/tables': (q: URLSearchParams) =>
    Response.json({ data: q.get('locationId') === HARBOUR.id ? [PIER] : [T2, T4, T6] }),
  'GET /api/v1/reservations/combinations': (q: URLSearchParams) =>
    Response.json({
      data:
        q.get('locationId') !== MAIN.id
          ? []
          : q.get('includeArchived') === 'true'
            ? [COMBO, OLD_COMBO]
            : [COMBO],
    }),
  'GET /api/v1/reservations/booking-page': () =>
    Response.json({ page: null, suggestedSlug: 'demo-bistro-main-street', online: true }),
};

const rows = () => screen.getAllByTestId('rule-row');
const row = (name: string) => rows().find((r) => r.dataset.name === name)!;

describe('Settings → Reservations tab', () => {
  it('is listed for holders of reservations.setup.manage with the feature only', () => {
    const tabsFor = (role: SystemRole, features: string[]) =>
      visibleNav(SETTINGS_TABS, {
        activeFeatures: features,
        activePermissions: [...systemRolePermissions(role)],
      }).map((t) => t.id);
    expect(tabsFor('manager', ['reservations'])).toContain('reservations');
    expect(tabsFor('admin', ['reservations'])).toContain('reservations');
    expect(tabsFor('manager', [])).not.toContain('reservations');
    expect(tabsFor('waiter', ['reservations'])).not.toContain('reservations');
    expect(tabsFor('host', ['reservations'])).not.toContain('reservations');
  });

  it('shows "no access" without the key or the feature', () => {
    signedInAs('waiter');
    render(<ReservationsSetupPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    cleanup();
    signedInAs('manager', ['pos']);
    render(<ReservationsSetupPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});

describe('ReservationsSetupPage: table rules', () => {
  it("lists the selected location's tables with their rules and switches location", async () => {
    signedInAs('manager');
    api(answers);
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('rule-row');
    expect(rows().map((r) => r.dataset.name)).toEqual(['T2', 'T4', 'T6']);
    expect(within(row('T6')).getByLabelText('Min. guests')).toHaveProperty('value', '4');
    expect(within(row('T6')).getByLabelText('Max. guests')).toHaveProperty('value', '');
    expect(within(row('T6')).getByLabelText('Max. guests')).toHaveProperty('placeholder', '6');
    await userEvent.selectOptions(screen.getByTestId('location-select'), HARBOUR.id);
    await waitFor(() => expect(rows().map((r) => r.dataset.name)).toEqual(['Pier 1']));
    expect(screen.getByTestId('combinations-empty')).toBeTruthy();
  });

  it('saves a changed rule, and only a changed one', async () => {
    signedInAs('manager');
    const { writes } = api({
      ...answers,
      [`PUT /api/v1/reservations/tables/${T4.id}/rule`]: () =>
        Response.json({ ...T4, bookingMode: 'staff_only', minParty: 2, maxParty: 5 }),
    });
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('rule-row');
    const t4 = row('T4');
    expect(within(t4).getByTestId('rule-save')).toHaveProperty('disabled', true);
    await userEvent.selectOptions(within(t4).getByLabelText('Bookable by'), 'staff_only');
    await userEvent.clear(within(t4).getByLabelText('Min. guests'));
    await userEvent.type(within(t4).getByLabelText('Min. guests'), '2');
    await userEvent.type(within(t4).getByLabelText('Max. guests'), '5');
    // More than the seats: allowed, with a hint.
    expect(within(t4).getByText('More guests than its 4 seats.')).toBeTruthy();
    await userEvent.click(within(t4).getByTestId('rule-save'));
    await waitFor(() => expect(within(row('T4')).getByText('Saved')).toBeTruthy());
    expect(writes).toEqual([
      {
        method: 'PUT',
        path: `/api/v1/reservations/tables/${T4.id}/rule`,
        body: { bookingMode: 'staff_only', minParty: 2, maxParty: 5 },
      },
    ]);
  });

  it('checks the range before sending and shows the api error label', async () => {
    signedInAs('manager');
    const { writes } = api({
      ...answers,
      [`PUT /api/v1/reservations/tables/${T2.id}/rule`]: () =>
        Response.json({ code: 'reservations.party_range_invalid', message: 'x' }, { status: 422 }),
    });
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('rule-row');
    const t2 = row('T2');
    await userEvent.clear(within(t2).getByLabelText('Min. guests'));
    await userEvent.type(within(t2).getByLabelText('Min. guests'), '3');
    await userEvent.click(within(t2).getByTestId('rule-save'));
    expect(within(t2).getByText("Min. can't be more than max. (2).")).toBeTruthy();
    await userEvent.clear(within(t2).getByLabelText('Min. guests'));
    await userEvent.type(within(t2).getByLabelText('Min. guests'), '0');
    await userEvent.click(within(t2).getByTestId('rule-save'));
    expect(within(t2).getByText('Enter a number from 1 to 100.')).toBeTruthy();
    expect(writes).toEqual([]);
    await userEvent.clear(within(t2).getByLabelText('Min. guests'));
    await userEvent.type(within(t2).getByLabelText('Min. guests'), '2');
    await userEvent.click(within(t2).getByTestId('rule-save'));
    await waitFor(() => expect(within(row('T2')).getByText(/Check the party sizes/)).toBeTruthy());
  });
});

describe('ReservationsSetupPage: combinations', () => {
  it('lists combinations with their tables and shows archived ones on request', async () => {
    signedInAs('manager');
    const { reads } = api(answers);
    render(<ReservationsSetupPage />);
    const [combo] = await screen.findAllByTestId('combination-row');
    expect(combo!.textContent).toContain('T4+T6');
    expect(combo!.textContent).toContain('T4 + T6');
    expect(combo!.textContent).toContain('7–10 guests');
    await userEvent.click(screen.getByTestId('toggle-archived'));
    await waitFor(() => expect(screen.getAllByTestId('combination-row')).toHaveLength(2));
    expect(screen.getAllByTestId('combination-row')[1]!.textContent).toContain('Archived');
    expect(reads.some((r) => r.includes('includeArchived=true'))).toBe(true);
  });

  it('creates a combination from in-service tables of the location only', async () => {
    signedInAs('manager');
    const { writes } = api({
      ...answers,
      'POST /api/v1/reservations/combinations': () =>
        Response.json({ ...COMBO, id: id(32), name: 'T2+T4' }, { status: 201 }),
    });
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('combination-row');
    await userEvent.click(screen.getByTestId('combination-create'));
    const dialog = await screen.findByRole('dialog');
    // Only the location's tables in service (the rules list), never another location's.
    expect(
      within(dialog)
        .getAllByTestId('combination-table')
        .map((c) => c.textContent),
    ).toEqual(['T2 · 2 seats', 'T4 · 4 seats', 'T6 · 6 seats']);
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter a name.')).toBeTruthy();
    expect(within(dialog).getByText('Choose 2 to 8 tables.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Name'), ' T2+T4 ');
    await userEvent.click(within(dialog).getByLabelText('T2 · 2 seats'));
    await userEvent.click(within(dialog).getByLabelText('T4 · 4 seats'));
    await userEvent.type(within(dialog).getByLabelText('Min. guests'), '5');
    await userEvent.type(within(dialog).getByLabelText('Max. guests'), '8');
    expect(within(dialog).getByText('More guests than the 6 seats of these tables.')).toBeTruthy();
    await userEvent.click(within(dialog).getByLabelText('Bookable online'));
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/reservations/combinations',
        body: {
          locationId: MAIN.id,
          name: 'T2+T4',
          tableIds: [T2.id, T4.id],
          minParty: 5,
          maxParty: 8,
          onlineBookable: false,
        },
      },
    ]);
  });

  it('edits only changed fields, and archives after confirming', async () => {
    signedInAs('manager');
    const { writes } = api({
      ...answers,
      [`PATCH /api/v1/reservations/combinations/${COMBO.id}`]: () => Response.json(COMBO),
    });
    render(<ReservationsSetupPage />);
    const [combo] = await screen.findAllByTestId('combination-row');
    await userEvent.click(within(combo!).getByTestId('combination-edit'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('T4 · 4 seats').getAttribute('aria-checked')).toBe('true');
    const max = within(dialog).getByLabelText('Max. guests');
    await userEvent.clear(max);
    await userEvent.type(max, '9');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(
      within(screen.getAllByTestId('combination-row')[0]!).getByTestId('archive'),
    );
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `/api/v1/reservations/combinations/${COMBO.id}`,
        body: { maxParty: 9 },
      },
      {
        method: 'PATCH',
        path: `/api/v1/reservations/combinations/${COMBO.id}`,
        body: { archived: true },
      },
    ]);
  });
});

describe('ReservationsSetupPage: location settings', () => {
  const settingRow = (key: string) =>
    screen.getAllByTestId('setting').find((r) => r.dataset.key === key)!;

  it("shows the location's reservations settings with where each comes from", async () => {
    signedInAs('manager');
    const { reads } = api(answers);
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('setting');
    expect(screen.getAllByTestId('setting').map((r) => r.dataset.key)).toEqual([
      'reservations.serviceHours',
      'reservations.slotIntervalMinutes',
      'reservations.holdMinutes',
    ]);
    expect(
      within(settingRow('reservations.serviceHours')).getByTestId('setting-source').textContent,
    ).toBe('Set here');
    expect(
      within(settingRow('reservations.slotIntervalMinutes')).getByTestId('setting-source')
        .textContent,
    ).toBe('Inherited');
    expect(reads.some((r) => r === `/api/v1/reservations/settings?locationId=${MAIN.id}`)).toBe(
      true,
    );
    // Never platform keys here.
    expect(screen.queryAllByTestId('setting').some((r) => r.dataset.key === 'openingHours')).toBe(
      false,
    );
  });

  it('explains the parts of the service hours outside the opening hours', async () => {
    signedInAs('manager');
    api(answers);
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('setting');
    const outside = within(settingRow('reservations.serviceHours')).getByTestId('service-outside');
    expect(outside.textContent).toContain('Saturday 10:00–11:00');
    expect(outside.textContent).toContain('Saturday 23:00–23:30');
  });

  it('sets a value at the location and inherits it again', async () => {
    signedInAs('manager');
    const { writes } = api({
      ...answers,
      'PUT /api/v1/reservations/settings/reservations.slotIntervalMinutes': () =>
        Response.json(setting('reservations.slotIntervalMinutes', 30, 'location')),
      'DELETE /api/v1/reservations/settings/reservations.serviceHours': () =>
        new Response(null, { status: 204 }),
    });
    render(<ReservationsSetupPage />);
    await screen.findAllByTestId('setting');
    const slot = settingRow('reservations.slotIntervalMinutes');
    await userEvent.selectOptions(within(slot).getByTestId('setting-value'), '30');
    await userEvent.click(within(slot).getByTestId('setting-save'));
    await waitFor(() =>
      expect(
        within(settingRow('reservations.slotIntervalMinutes')).getByTestId('setting-source')
          .textContent,
      ).toBe('Set here'),
    );
    await userEvent.click(
      within(settingRow('reservations.serviceHours')).getByTestId('setting-inherit'),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      {
        method: 'PUT',
        path: '/api/v1/reservations/settings/reservations.slotIntervalMinutes',
        body: { value: 30 },
      },
      {
        method: 'DELETE',
        path: '/api/v1/reservations/settings/reservations.serviceHours',
        body: null,
      },
    ]);
  });
});

describe('ReservationsSetupPage: online booking page (R2.1)', () => {
  const PAGE = {
    locationId: MAIN.id,
    slug: 'demo-bistro',
    enabled: true,
    path: '/b/demo-bistro',
    online: true,
  };

  it('suggests an address, checks it, and saves it', async () => {
    signedInAs('manager');
    const { writes } = api({
      ...answers,
      'PUT /api/v1/reservations/booking-page': () => Response.json(PAGE),
    });
    render(<ReservationsSetupPage />);
    const card = await screen.findByTestId('booking-page-card');
    const slug = await within(card).findByTestId<HTMLInputElement>('booking-page-slug');
    expect(slug.value).toBe('demo-bistro-main-street');
    expect(within(card).queryByTestId('booking-page-link')).toBeNull();

    await userEvent.clear(slug);
    await userEvent.type(slug, 'no');
    await userEvent.click(within(card).getByTestId('booking-page-save'));
    expect(within(card).getByRole('alert').textContent).toContain('3 to 60');
    expect(writes).toEqual([]);

    await userEvent.clear(slug);
    await userEvent.type(slug, 'Demo-Bistro');
    expect(slug.value).toBe('demo-bistro');
    await userEvent.click(within(card).getByTestId('booking-page-save'));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: 'PUT',
          path: '/api/v1/reservations/booking-page',
          body: { locationId: MAIN.id, slug: 'demo-bistro', enabled: true },
        },
      ]),
    );
  });

  it('shows the link on this domain, and a taken address', async () => {
    signedInAs('manager');
    api({
      ...answers,
      'GET /api/v1/reservations/booking-page': () =>
        Response.json({ page: PAGE, suggestedSlug: 'x', online: true }),
      'PUT /api/v1/reservations/booking-page': () =>
        Response.json(
          { code: 'reservations.booking_slug_taken', message: 'taken' },
          { status: 409 },
        ),
    });
    render(<ReservationsSetupPage />);
    const card = await screen.findByTestId('booking-page-card');
    expect((await within(card).findByTestId('booking-page-link')).textContent).toBe(
      `${window.location.origin}/b/demo-bistro`,
    );
    const slug = within(card).getByTestId<HTMLInputElement>('booking-page-slug');
    await userEvent.type(slug, '-two');
    await userEvent.click(within(card).getByTestId('booking-page-save'));
    expect(
      await within(card).findByText('This address is already taken. Choose another one.'),
    ).toBeTruthy();
  });

  it('says when the plan has no online booking', async () => {
    signedInAs('manager');
    api({
      ...answers,
      'GET /api/v1/reservations/booking-page': () =>
        Response.json({ page: null, suggestedSlug: 'x', online: false }),
    });
    render(<ReservationsSetupPage />);
    const card = await screen.findByTestId('booking-page-card');
    expect(await within(card).findByText(/not in your plan/)).toBeTruthy();
  });
});
