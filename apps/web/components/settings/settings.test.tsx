// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { LabelsPage } from './labels-page';
import { LocationsPage, NoLocations } from './locations-page';
import { NumberingPage } from './numbering-page';
import { OrganizationPage } from './organization-page';
import { PlanPage } from './plan-page';
import { SettingsIndex, SettingsTabs } from './settings-tabs';
import { SettingsPage } from './settings-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const signedInAs = (key: SystemRole) => {
  mockState.session = sessionFixture({
    activeRole: { id: '0190a000-0000-7000-8000-000000000101', systemKey: key, name: null },
    activePermissions: [...systemRolePermissions(key)],
  });
};

type Answer = (init?: RequestInit) => Response;

/** Answers by method and path, like the api would; records the writes. */
function api(answers: Record<string, Answer>) {
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const answer = answers[`${init?.method ?? 'GET'} ${input}`] ?? answers[`GET ${input}`];
    return Promise.resolve(answer ? answer(init) : Response.json({ data: [] }));
  });
}

const writes = () =>
  mockState.store.apiFetch.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([input, init]) => ({
      call: `${init?.method} ${input}`,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      key: new Headers(init?.headers).get('Idempotency-Key'),
    }));

/** Any Idempotency-Key (a random UUID per action). */
const ANY_KEY: unknown = expect.any(String);

const SETTINGS = [
  { key: 'locale', value: 'en', source: 'default', dataBound: false },
  { key: 'currency', value: 'EUR', source: 'partner', dataBound: true },
  { key: 'timezone', value: 'Europe/Berlin', source: 'default', dataBound: false },
  {
    key: 'inventory.valuationMethod',
    value: 'weighted_average',
    source: 'default',
    dataBound: true,
  },
  { key: 'inventory.allowNegativeStock', value: false, source: 'organization', dataBound: false },
];
const DAY = [{ from: '11:00', to: '23:00' }];
const OPENING_HOURS = {
  key: 'openingHours',
  value: { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY, sun: DAY },
  source: 'default',
  dataBound: false,
};
const CLOSED_DATES = {
  key: 'closedDates',
  value: ['2026-12-25'],
  source: 'default',
  dataBound: false,
};
const settingCard = async (key: string) =>
  (await screen.findAllByTestId('setting')).find((c) => c.dataset.key === key)!;

describe('SettingsPage: reservations', () => {
  const reservation = (key: string, value: unknown) => ({
    key: `reservations.${key}`,
    value,
    source: 'default',
    dataBound: false,
  });
  const TURN_TIMES = [
    { fromParty: 1, toParty: 2, minutes: 90 },
    { fromParty: 3, toParty: 4, minutes: 120 },
    { fromParty: 5, toParty: null, minutes: 150 },
  ];
  const DATA = [
    ...SETTINGS,
    OPENING_HOURS,
    reservation('serviceHours', 'openingHours'),
    reservation('slotIntervalMinutes', 15),
    reservation('turnTimes', TURN_TIMES),
    reservation('maxCoversPerSlot', 'off'),
    reservation('holdMinutes', 5),
  ];
  const answers = () => {
    const echo = (key: string) => (init?: RequestInit) =>
      Response.json({
        key,
        value: (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { value: unknown })
          .value,
        source: 'organization',
        dataBound: false,
      });
    return {
      'GET /api/v1/settings': () => Response.json({ data: DATA }),
      ...Object.fromEntries(
        DATA.map((d) => [`PUT /api/v1/settings/${d.key}`, echo(d.key)] as const),
      ),
    };
  };

  it('sends the slot interval and hold time as numbers, and refuses out-of-range minutes', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const slots = await settingCard('reservations.slotIntervalMinutes');
    await userEvent.selectOptions(within(slots).getByTestId('setting-value'), '30');
    await userEvent.click(within(slots).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ value: 30 });

    const hold = await settingCard('reservations.holdMinutes');
    const input = within(hold).getByTestId('setting-value');
    await userEvent.clear(input);
    await userEvent.type(input, '20');
    expect(within(hold).getByRole('alert')).toBeTruthy();
    expect(within(hold).getByTestId<HTMLButtonElement>('setting-save').disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    await userEvent.click(within(hold).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]?.body).toEqual({ value: 10 });
  });

  it('switches the guests-per-slot limit on and off', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('reservations.maxCoversPerSlot');
    const off = within(card).getByRole('checkbox', { name: 'No limit' });
    expect(off.getAttribute('aria-checked')).toBe('true');
    expect(within(card).queryByTestId('setting-value')).toBeNull();
    await userEvent.click(off);
    const input = within(card).getByTestId('setting-value');
    await userEvent.clear(input);
    await userEvent.type(input, '40');
    await userEvent.click(within(card).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ value: 40 });
  });

  it('follows the opening hours until narrower reservation hours are set', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('reservations.serviceHours');
    const same = within(card).getByRole('checkbox', { name: 'Same as the opening hours' });
    expect(same.getAttribute('aria-checked')).toBe('true');
    expect(within(card).queryByTestId('hours-day-mon')).toBeNull();
    await userEvent.click(same);
    // Starts from the opening hours, to narrow them.
    const monday = within(card).getByTestId('hours-day-mon');
    await userEvent.click(within(monday).getByRole('button', { name: 'Remove window' }));
    await userEvent.click(within(card).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ value: { ...OPENING_HOURS.value, mon: [] } });
  });

  it('edits turn times per party size and keeps the bands contiguous', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('reservations.turnTimes');
    const rows = () => within(card).getAllByTestId('turn-time');
    expect(rows().map((r) => r.dataset.label)).toEqual(['1–2 guests', '3–4 guests', '5+ guests']);
    // Middle band up to 6 guests: the last band now starts at 7.
    await userEvent.clear(within(rows()[1]!).getByLabelText('Up to'));
    await userEvent.type(within(rows()[1]!).getByLabelText('Up to'), '6');
    await userEvent.clear(within(rows()[0]!).getByLabelText('Minutes'));
    await userEvent.type(within(rows()[0]!).getByLabelText('Minutes'), '75');
    expect(rows().map((r) => r.dataset.label)).toEqual(['1–2 guests', '3–6 guests', '7+ guests']);
    await userEvent.click(within(card).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({
      value: [
        { fromParty: 1, toParty: 2, minutes: 75 },
        { fromParty: 3, toParty: 6, minutes: 120 },
        { fromParty: 7, toParty: null, minutes: 150 },
      ],
    });
  });

  it('adds and removes a party size, the last band always open', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('reservations.turnTimes');
    const labels = () =>
      within(card)
        .getAllByTestId('turn-time')
        .map((r) => r.dataset.label);
    await userEvent.click(within(card).getByRole('button', { name: 'Add a party size' }));
    expect(labels()).toEqual(['1–2 guests', '3–4 guests', '5 guests', '6+ guests']);
    const removes = within(card).getAllByRole('button', { name: 'Remove party size' });
    await userEvent.click(removes[removes.length - 1]!);
    expect(labels()).toEqual(['1–2 guests', '3–4 guests', '5+ guests']);
  });
});

describe('SettingsPage: opening hours and closed days', () => {
  const answers = () => ({
    'GET /api/v1/settings': () =>
      Response.json({ data: [...SETTINGS, OPENING_HOURS, CLOSED_DATES] }),
    'PUT /api/v1/settings/openingHours': (init?: RequestInit) =>
      Response.json({
        ...OPENING_HOURS,
        ...(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as object),
        source: 'organization',
      }),
    'PUT /api/v1/settings/closedDates': (init?: RequestInit) =>
      Response.json({
        ...CLOSED_DATES,
        ...(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as object),
        source: 'organization',
      }),
  });

  it('edits the weekly windows: closes a day, adds a lunch window, sends the whole week', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('openingHours');
    const monday = within(card).getByTestId('hours-day-mon');
    await userEvent.click(within(monday).getByRole('button', { name: 'Remove window' }));
    expect(within(monday).getByText('Closed')).toBeTruthy();
    const tuesday = within(card).getByTestId('hours-day-tue');
    await userEvent.click(within(tuesday).getByRole('button', { name: 'Add window' }));
    const from = within(tuesday).getAllByLabelText('Opens')[1]!;
    const to = within(tuesday).getAllByLabelText('Closes')[1]!;
    await userEvent.clear(from);
    await userEvent.type(from, '23:30');
    await userEvent.clear(to);
    await userEvent.type(to, '02:00');
    await userEvent.click(within(card).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      call: 'PUT /api/v1/settings/openingHours',
      body: {
        value: {
          ...OPENING_HOURS.value,
          mon: [],
          tue: [
            { from: '11:00', to: '23:00' },
            { from: '23:30', to: '02:00' },
          ],
        },
      },
      key: ANY_KEY,
    });
  });

  it('refuses overlapping windows before sending', async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('openingHours');
    const friday = within(card).getByTestId('hours-day-fri');
    await userEvent.click(within(friday).getByRole('button', { name: 'Add window' }));
    // The new window starts where the last one ends (23:00); moving it to 22:00 overlaps.
    const from = within(friday).getAllByLabelText('Opens')[1]!;
    await userEvent.clear(from);
    await userEvent.type(from, '22:00');
    expect(within(card).getByRole('alert').textContent).toBe(
      "This value isn't valid for this setting.",
    );
    expect(within(card).getByTestId<HTMLButtonElement>('setting-save').disabled).toBe(true);
  });

  it("adds and removes closed days, sorted and shown in the user's locale", async () => {
    signedInAs('admin');
    api(answers());
    render(<SettingsPage />);
    const card = await settingCard('closedDates');
    await userEvent.type(within(card).getByLabelText('Date to add'), '2026-12-24');
    await userEvent.click(within(card).getByRole('button', { name: 'Add day' }));
    expect(
      within(card)
        .getAllByTestId('closed-date')
        .map((d) => d.dataset.date),
    ).toEqual(['2026-12-24', '2026-12-25']);
    expect(
      within(card)
        .getAllByTestId('closed-date')
        .map((d) => d.textContent),
    ).toEqual(['Dec 24, 2026', 'Dec 25, 2026']);
    await userEvent.click(within(card).getByRole('button', { name: 'Remove Dec 25, 2026' }));
    await userEvent.click(within(card).getByTestId('setting-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      call: 'PUT /api/v1/settings/closedDates',
      body: { value: ['2026-12-24'] },
    });
  });

  it('shows both read-only to members without platform.settings.manage', async () => {
    signedInAs('staff');
    api(answers());
    render(<SettingsPage />);
    const hours = await settingCard('openingHours');
    expect(within(hours).queryByRole('button', { name: 'Add window' })).toBeNull();
    expect(within(hours).getAllByLabelText<HTMLInputElement>('Opens')[0]!.disabled).toBe(true);
    const closed = await settingCard('closedDates');
    expect(within(closed).queryByRole('button', { name: 'Add day' })).toBeNull();
  });
});

describe('SettingsPage', () => {
  it('generates a control per key and shows where the value comes from', async () => {
    signedInAs('admin');
    api({ 'GET /api/v1/settings': () => Response.json({ data: SETTINGS }) });
    render(<SettingsPage />);
    const negative = await settingCard('inventory.allowNegativeStock');
    expect(within(negative).getByTestId('setting-source').textContent).toBe('Set here');
    expect(within(negative).getByTestId('setting-inherit')).toBeTruthy();
    const currency = await settingCard('currency');
    expect(within(currency).getByTestId('setting-source').textContent).toBe('Inherited');
    expect(within(currency).getByTestId('setting-data-bound')).toBeTruthy();
    const valuation = within(await settingCard('inventory.valuationMethod')).getByTestId(
      'setting-value',
    );
    expect(
      within(valuation)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['FIFO (first in, first out)', 'Weighted average']);
  });

  it("checks a text value against the key's schema before sending", async () => {
    signedInAs('admin');
    api({ 'GET /api/v1/settings': () => Response.json({ data: SETTINGS }) });
    render(<SettingsPage />);
    const timezone = await settingCard('timezone');
    const input = within(timezone).getByTestId('setting-value');
    await userEvent.clear(input);
    await userEvent.type(input, 'Mars/Olympus');
    expect(within(timezone).getByRole('alert').textContent).toBe(
      "This value isn't valid for this setting.",
    );
    expect(within(timezone).getByTestId<HTMLButtonElement>('setting-save').disabled).toBe(true);
  });

  it('confirms a data-bound change, then shows settings.in_use clearly and locks the row', async () => {
    signedInAs('admin');
    api({
      'GET /api/v1/settings': () => Response.json({ data: SETTINGS }),
      'PUT /api/v1/settings/currency': () =>
        Response.json({ code: 'settings.in_use', message: 'raw' }, { status: 409 }),
    });
    render(<SettingsPage />);
    const currency = await settingCard('currency');
    await userEvent.selectOptions(within(currency).getByTestId('setting-value'), 'CHF');
    await userEvent.click(within(currency).getByTestId('setting-save'));
    expect(writes()).toEqual([]); // nothing sent before the confirmation
    await userEvent.click(await screen.findByTestId('setting-confirm'));
    expect(await within(currency).findByRole('alert')).toBeTruthy();
    expect(within(currency).getByRole('alert').textContent).toBe(
      "This setting can't be changed anymore: data has already been recorded with it.",
    );
    expect(writes()).toEqual([
      { call: 'PUT /api/v1/settings/currency', body: { value: 'CHF' }, key: ANY_KEY },
    ]);
    expect(within(currency).getByTestId<HTMLSelectElement>('setting-value').disabled).toBe(true);
    expect(within(currency).queryByTestId('setting-save')).toBeNull();
  });

  it('falls back to the code defaults, read-only, when GET /settings is denied', async () => {
    signedInAs('admin');
    api({
      'GET /api/v1/settings': () =>
        Response.json({ code: 'rbac.permission_denied' }, { status: 403 }),
    });
    render(<SettingsPage />);
    expect((await screen.findByRole('status')).textContent).toContain(
      "You don't have permission to do this.",
    );
    const currency = await settingCard('currency');
    expect(within(currency).getByTestId<HTMLSelectElement>('setting-value').value).toBe('EUR');
    expect(within(currency).queryByTestId('setting-save')).toBeNull();
  });

  it('is read-only without platform.settings.manage', async () => {
    signedInAs('staff');
    api({ 'GET /api/v1/settings': () => Response.json({ data: SETTINGS }) });
    render(<SettingsPage />);
    const locale = await settingCard('locale');
    expect(within(locale).queryByTestId('setting-save')).toBeNull();
  });
});

describe('LabelsPage', () => {
  const overrides = [
    {
      locale: 'en',
      key: 'inventory.nav.title',
      value: 'Stock',
      defaultValue: 'Inventory',
      active: true,
    },
    { locale: 'en', key: 'gone.nav.title', value: 'Old', defaultValue: null, active: false },
  ];
  const labelRow = async (key: string) =>
    (await screen.findAllByTestId('label-row')).find((r) => r.dataset.key === key)!;

  it('shows "no access" without platform.labels.manage', () => {
    signedInAs('manager');
    render(<LabelsPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('offers only overridable keys, validates inline, previews, saves and reloads the nav labels', async () => {
    signedInAs('owner');
    api({
      'GET /api/v1/label-overrides': () => Response.json({ data: overrides }),
      'GET /api/v1/labels?locale=en': () =>
        Response.json({ locale: 'en', data: { 'inventory.nav.title': 'Stock' } }),
      'PUT /api/v1/label-overrides/en/billing.nav.title': (init) =>
        Response.json({
          locale: 'en',
          key: 'billing.nav.title',
          value: (
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { value: string }
          ).value,
          defaultValue: 'Billing',
          active: true,
        }),
    });
    render(<LabelsPage />);
    const rows = await screen.findAllByTestId('label-row');
    expect(rows.some((r) => r.dataset.key === 'platform.app.name')).toBe(false);
    expect(rows.every((r) => /\.(nav|entities|fields)\./.test(r.dataset.key ?? ''))).toBe(true);

    const billing = await labelRow('billing.nav.title');
    const input = within(billing).getByTestId('label-value');
    // `{{` types one brace: the value is `Invoices {count}`, a placeholder the default lacks.
    await userEvent.type(input, 'Invoices {{count}');
    expect(within(billing).getByRole('alert').textContent).toBe(
      'Keep exactly the placeholders of the default text: none. Found: {count}.',
    );
    expect(within(billing).getByTestId<HTMLButtonElement>('label-save').disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, 'Invoices');
    expect(within(billing).queryByRole('alert')).toBeNull();
    expect(within(billing).getByTestId('label-preview').textContent).toContain('Invoices');
    await userEvent.click(within(billing).getByTestId('label-save'));
    await waitFor(() => expect(mockState.reloadLabels).toHaveBeenCalled());
    expect(writes()).toEqual([
      {
        call: 'PUT /api/v1/label-overrides/en/billing.nav.title',
        body: { value: 'Invoices' },
        key: ANY_KEY,
      },
    ]);
  });

  it('lists inactive rows with their reason and a remove action', async () => {
    signedInAs('owner');
    api({ 'GET /api/v1/label-overrides': () => Response.json({ data: overrides }) });
    render(<LabelsPage />);
    const inactive = await screen.findByTestId('inactive-label');
    expect(inactive.textContent).toContain('This text no longer exists.');
    expect(within(inactive).getByTestId('inactive-label-remove')).toBeTruthy();
  });
});

describe('NumberingPage', () => {
  const series = {
    key: 'billing.invoice',
    prefix: 'INV',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
    period: '2026',
    nextValue: '42',
    preview: 'INV-2026-000042',
    resetPolicyLocked: true,
  };

  it('previews the edited pattern live and lists its problems', async () => {
    signedInAs('admin');
    api({ 'GET /api/v1/number-series': () => Response.json({ data: [series] }) });
    render(<NumberingPage />);
    const pattern = await screen.findByTestId('series-pattern');
    await userEvent.clear(pattern);
    await userEvent.type(pattern, '{{prefix}/{{YY}/{{seq:4}');
    expect(screen.getByTestId('series-live-preview').textContent).toContain('INV/26/0042');
    await userEvent.clear(pattern);
    await userEvent.type(pattern, '{{prefix}');
    expect(screen.getByRole('alert').textContent).toContain(
      'The pattern needs the sequence number placeholder',
    );
  });

  it('locks the reset policy once numbers exist', async () => {
    signedInAs('admin');
    api({ 'GET /api/v1/number-series': () => Response.json({ data: [series] }) });
    render(<NumberingPage />);
    expect(await screen.findByTestId('reset-locked')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Restart numbering').disabled).toBe(true);
  });

  it('only raises the counter', async () => {
    signedInAs('admin');
    api({
      'GET /api/v1/number-series': () => Response.json({ data: [series] }),
      'PUT /api/v1/number-series/billing.invoice/counter': () =>
        Response.json({ ...series, nextValue: '100', preview: 'INV-2026-000100' }),
    });
    render(<NumberingPage />);
    const value = await screen.findByTestId('counter-value');
    await userEvent.type(value, '42');
    expect(screen.getByRole('alert').textContent).toBe(
      'The counter can only be raised: enter more than 42.',
    );
    expect(screen.getByTestId<HTMLButtonElement>('counter-raise').disabled).toBe(true);
    await userEvent.clear(value);
    await userEvent.type(value, '100');
    await userEvent.click(screen.getByTestId('counter-raise'));
    expect(await screen.findByText('INV-2026-000100')).toBeTruthy();
    expect(writes()).toEqual([
      {
        call: 'PUT /api/v1/number-series/billing.invoice/counter',
        body: { nextValue: '100' },
        key: ANY_KEY,
      },
    ]);
  });

  it('is read-only without platform.settings.manage', async () => {
    signedInAs('staff');
    api({ 'GET /api/v1/number-series': () => Response.json({ data: [series] }) });
    render(<NumberingPage />);
    await screen.findByTestId('number-series');
    expect(screen.queryByTestId('counter-raise')).toBeNull();
  });
});

describe('OrganizationPage', () => {
  it('renames with platform.org.manage and refreshes the session', async () => {
    signedInAs('owner');
    api({
      'PATCH /api/v1/organization': () =>
        Response.json({ id: '0190a000-0000-7000-8000-0000000000a1', name: 'Bistro Nord' }),
    });
    render(<OrganizationPage />);
    const input = screen.getByTestId('organization-name');
    expect((input as HTMLInputElement).value).toBe('Demo Bistro');
    await userEvent.clear(input);
    await userEvent.type(input, 'Bistro Nord');
    await userEvent.click(screen.getByTestId('organization-save'));
    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    expect(mockState.store.refresh).toHaveBeenCalled();
    expect(writes()).toEqual([
      {
        call: 'PATCH /api/v1/organization',
        body: { name: 'Bistro Nord' },
        key: ANY_KEY,
      },
    ]);
  });

  it('is read-only for Admins (no platform.org.manage)', () => {
    signedInAs('admin');
    render(<OrganizationPage />);
    expect(screen.queryByTestId('organization-name')).toBeNull();
    expect(screen.getByText('Demo Bistro')).toBeTruthy();
  });
});

const L1 = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  name: 'Main street',
  brandId: '0190a000-0000-7000-8000-0000000000b1',
};

describe('LocationsPage', () => {
  it('lets owners add, rename and delete, and explains a location still in use', async () => {
    signedInAs('owner');
    api({
      'GET /api/v1/locations': () => Response.json({ data: [L1] }),
      'POST /api/v1/locations': () =>
        Response.json({ ...L1, id: '0190a000-0000-7000-8000-0000000000c2', name: 'Harbour' }),
      [`PATCH /api/v1/locations/${L1.id}`]: () => Response.json({ ...L1, name: 'Old town' }),
      [`DELETE /api/v1/locations/${L1.id}`]: () =>
        Response.json({ code: 'locations.in_use', message: 'raw' }, { status: 409 }),
    });
    render(<LocationsPage />);
    expect((await screen.findByTestId('location-row')).textContent).toContain('Main street');

    await userEvent.click(screen.getByTestId('location-create'));
    await userEvent.click(screen.getByTestId('form-save'));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name.');
    await userEvent.type(screen.getByTestId('location-name'), ' Harbour ');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByTestId('location-name')).toBeNull());

    await userEvent.click(screen.getByTestId('location-rename'));
    const input = screen.getByTestId('location-name');
    expect((input as HTMLInputElement).value).toBe('Main street');
    await userEvent.clear(input);
    await userEvent.type(input, 'Old town');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByTestId('location-name')).toBeNull());

    await userEvent.click(screen.getByTestId('location-delete'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toContain('still in use');

    expect(writes()).toEqual([
      { call: 'POST /api/v1/locations', body: { name: 'Harbour' }, key: ANY_KEY },
      { call: `PATCH /api/v1/locations/${L1.id}`, body: { name: 'Old town' }, key: ANY_KEY },
      { call: `DELETE /api/v1/locations/${L1.id}`, body: null, key: ANY_KEY },
    ]);
  });

  it('is read-only for Admins (no platform.org.manage)', async () => {
    signedInAs('admin');
    api({ 'GET /api/v1/locations': () => Response.json({ data: [L1] }) });
    render(<LocationsPage />);
    expect(await screen.findByTestId('location-row')).toBeTruthy();
    expect(screen.queryByTestId('location-create')).toBeNull();
    expect(screen.queryByTestId('location-rename')).toBeNull();
    expect(screen.queryByTestId('location-delete')).toBeNull();
    expect(screen.getByText('Only owners can add, rename or delete locations.')).toBeTruthy();
  });

  it('links owners, and only owners, from "no locations" to this page', () => {
    signedInAs('owner');
    render(<NoLocations message="You have no locations." />);
    expect(screen.getByTestId('add-first-location').getAttribute('href')).toBe(
      '/settings/locations',
    );
    cleanup();
    signedInAs('manager');
    render(<NoLocations message="You have no locations." />);
    expect(screen.queryByTestId('add-first-location')).toBeNull();
  });
});

describe('PlanPage', () => {
  it('shows the plan, its features and limits, read-only', async () => {
    signedInAs('staff');
    api({
      'GET /api/v1/me/entitlements': () =>
        Response.json({
          plan: { key: 'inventory' },
          features: [
            { key: 'inventory', limits: { maxLocations: 3 } },
            { key: 'reports', limits: {} },
          ],
        }),
    });
    render(<PlanPage />);
    expect((await screen.findByTestId('plan-name')).textContent).toBe('Inventory');
    const features = screen.getAllByTestId('plan-feature');
    expect(features.map((f) => f.dataset.feature)).toEqual(['inventory', 'reports']);
    expect(features[0]?.textContent).toContain('Locations');
    expect(features[0]?.textContent).toContain('3');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('SettingsTabs', () => {
  const tabIds = () =>
    screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('data-testid')?.replace('settings-tab-', ''));

  it('shows every tab to an owner and marks the current one', () => {
    signedInAs('owner');
    mockState.pathname = '/settings/locations';
    render(<SettingsTabs />);
    expect(tabIds()).toEqual([
      'organization',
      'locations',
      'general',
      'numbering',
      'labels',
      'plan',
    ]);
    expect(screen.getByTestId('settings-tab-locations').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('settings-tab-organization').textContent).toBe('Company');
  });

  it('shows a waiter only the tabs they may read', () => {
    signedInAs('waiter');
    render(<SettingsTabs />);
    expect(tabIds()).toEqual(['organization', 'locations', 'general', 'numbering', 'plan']);
  });

  it('opens the first tab at /settings', async () => {
    signedInAs('staff');
    render(<SettingsIndex />);
    await waitFor(() =>
      expect(mockState.router.replace).toHaveBeenCalledWith('/settings/organization'),
    );
  });
});
