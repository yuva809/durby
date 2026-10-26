// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { LabelsPage } from './labels-page';
import { NumberingPage } from './numbering-page';
import { OrganizationPage } from './organization-page';
import { PlanPage } from './plan-page';
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
const settingCard = async (key: string) =>
  (await screen.findAllByTestId('setting')).find((c) => c.dataset.key === key)!;

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
