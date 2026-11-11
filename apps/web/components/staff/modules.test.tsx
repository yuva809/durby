// @vitest-environment jsdom
import type { CustomerEntitlements, FeatureCatalogResponse } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaffResult } from '../../lib/staff/api';
import { CustomerModules } from './modules';

// A fake catalog with made-up label keys: the component shows whatever the catalog says, so a new
// module needs no portal change (t() returns an unknown key as is).
// Real keys (the shared schema accepts registered keys only), fake labels.
const KEYS: Record<string, string> = {
  base: 'catalog',
  till: 'pos',
  'till.tax': 'pos.fiscal',
  stock: 'inventory',
};
const f = (name: string, dependsOn: string[] = []) => ({
  key: KEYS[name],
  label: `fake.${name}.name`,
  description: `fake.${name}.description`,
  dependsOn: dependsOn.map((d) => KEYS[d]),
  order: 0,
  limits: [],
});
const CATALOG = {
  modules: [
    { ...f('base'), features: [] },
    { ...f('till', ['base']), features: [f('till.tax', ['till'])] },
    { ...f('stock'), features: [] },
  ],
  plans: [
    { key: 'inventory', label: 'fake.plan.small', features: ['catalog', 'inventory'] },
    { key: 'inventory_billing', label: 'fake.plan.mid', features: ['catalog', 'inventory'] },
    {
      key: 'full',
      label: 'fake.plan.full',
      features: ['catalog', 'pos', 'pos.fiscal', 'inventory'],
    },
  ],
} as unknown as FeatureCatalogResponse;

const ID = '0190a000-0000-7000-8000-0000000000c1';
const row = (name: string, inPlan: boolean, override: object | null = null) => ({
  key: KEYS[name],
  enabled: inPlan,
  inPlan,
  source: override ? 'override' : 'plan',
  blockedBy: [],
  override: override && {
    enabled: false,
    limits: null,
    reason: 'r',
    expiresOn: null,
    expired: false,
    setBy: null,
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...override,
  },
});
const ENTITLEMENTS = {
  customerId: ID,
  plan: 'inventory',
  features: [row('base', true), row('till', false), row('till.tax', false), row('stock', true)],
} as unknown as CustomerEntitlements;

const calls: { key: string; body: unknown }[] = [];
function api(answers: Record<string, (() => Response)[]>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${input.replace('/api/v1/platform', '')}`;
      calls.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      const answer = answers[key];
      const fn = answer && (answer.length > 1 ? answer.shift() : answer[0]);
      return Promise.resolve(fn ? fn() : Response.json({ code: 'unknown' }, { status: 500 }));
    }),
  );
}
const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const passthrough = <T,>(run: () => Promise<StaffResult<T>>) => run();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(canManage = true) {
  render(
    <CustomerModules
      customerId={ID}
      canManage={canManage}
      guard={passthrough}
      onPlanChanged={() => undefined}
    />,
  );
}

describe('CustomerModules', () => {
  it('renders one card per catalog module, with plan badges', async () => {
    api({
      'GET /feature-catalog': [json(CATALOG)],
      [`GET /customers/${ID}/entitlements`]: [json(ENTITLEMENTS)],
    });
    renderCard();
    const till = await screen.findByTestId('module-pos');
    expect(till.textContent).toMatch('fake.till.name');
    expect(screen.getByTestId('module-pos.fiscal')).toBeTruthy();
    expect(within(screen.getByTestId('module-catalog')).getByText('Plan')).toBeTruthy();
  });

  it('is read-only without the manage permission', async () => {
    api({
      'GET /feature-catalog': [json(CATALOG)],
      [`GET /customers/${ID}/entitlements`]: [json(ENTITLEMENTS)],
    });
    renderCard(false);
    const box = within(await screen.findByTestId('module-pos')).getByRole('checkbox');
    expect(box.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('modules-change-plan')).toBeNull();
  });

  it('ticks what a sub-feature needs, asks for a reason, and saves in dependency order', async () => {
    const user = userEvent.setup();
    api({
      'GET /feature-catalog': [json(CATALOG)],
      [`GET /customers/${ID}/entitlements`]: [json(ENTITLEMENTS)],
      [`PUT /customers/${ID}/features/pos`]: [json(ENTITLEMENTS)],
      [`PUT /customers/${ID}/features/pos.fiscal`]: [json(ENTITLEMENTS)],
    });
    renderCard();
    await user.click(within(await screen.findByTestId('module-pos.fiscal')).getByRole('checkbox'));
    expect(screen.getByText('Also switched on: fake.till.name')).toBeTruthy();
    await user.click(screen.getByTestId('modules-review'));
    const dialog = await screen.findByTestId('modules-dialog');
    expect(within(dialog).getByTestId('modules-summary').textContent).toMatch(
      'fake.till.name: onfake.till.tax.name: on',
    );
    await user.click(within(dialog).getByTestId('modules-save'));
    expect(within(dialog).getByRole('alert').textContent).toMatch('Enter a reason.');
    expect(calls.filter((c) => c.key.startsWith('PUT'))).toEqual([]);

    await user.type(within(dialog).getByTestId('modules-reason'), 'Trial');
    await user.type(within(dialog).getByTestId('modules-expires'), '2099-10-25');
    await user.click(within(dialog).getByTestId('modules-save'));
    await screen.findByText('Modules saved.');
    expect(calls.filter((c) => c.key.startsWith('PUT'))).toEqual([
      {
        key: `PUT /customers/${ID}/features/pos`,
        body: { enabled: true, reason: 'Trial', expiresOn: '2099-10-25' },
      },
      {
        key: `PUT /customers/${ID}/features/pos.fiscal`,
        body: { enabled: true, reason: 'Trial', expiresOn: '2099-10-25' },
      },
    ]);
  });

  it('says which changes were saved and which were not, and retries nothing', async () => {
    const user = userEvent.setup();
    api({
      'GET /feature-catalog': [json(CATALOG)],
      [`GET /customers/${ID}/entitlements`]: [json(ENTITLEMENTS)],
      [`PUT /customers/${ID}/features/pos`]: [json(ENTITLEMENTS)],
      [`PUT /customers/${ID}/features/pos.fiscal`]: [
        json({ code: 'staff.feature_dependency_missing', message: 'x' }, 409),
      ],
    });
    renderCard();
    await user.click(within(await screen.findByTestId('module-pos.fiscal')).getByRole('checkbox'));
    await user.click(screen.getByTestId('modules-review'));
    const dialog = await screen.findByTestId('modules-dialog');
    await user.type(within(dialog).getByTestId('modules-reason'), 'Trial');
    await user.click(within(dialog).getByTestId('modules-save'));
    await waitFor(() =>
      expect(screen.getByText(/Not everything was saved/).textContent).toMatch(
        /Saved: fake\.till\.name\. Not saved: fake\.till\.tax\.name/,
      ),
    );
    expect(calls.filter((c) => c.key.includes('pos.fiscal'))).toHaveLength(1);
  });

  it('resets a module to the plan through POST …/reset with the reason', async () => {
    const user = userEvent.setup();
    const custom = {
      ...ENTITLEMENTS,
      features: [
        row('base', true),
        row('till', false),
        row('till.tax', false),
        row('stock', true, { enabled: false }),
      ],
    };
    api({
      'GET /feature-catalog': [json(CATALOG)],
      [`GET /customers/${ID}/entitlements`]: [json(custom)],
      [`POST /customers/${ID}/features/inventory/reset`]: [json(ENTITLEMENTS)],
    });
    renderCard();
    await user.click(await screen.findByTestId('module-reset-inventory'));
    await user.click(screen.getByTestId('modules-review'));
    const dialog = await screen.findByTestId('modules-dialog');
    expect(within(dialog).queryByTestId('modules-expires')).toBeNull();
    await user.type(within(dialog).getByTestId('modules-reason'), 'Back to normal');
    await user.click(within(dialog).getByTestId('modules-save'));
    await screen.findByText('Modules saved.');
    expect(calls.find((c) => c.key.endsWith('/reset'))?.body).toEqual({ reason: 'Back to normal' });
  });

  it('lists the custom switches a plan change keeps', async () => {
    const user = userEvent.setup();
    const custom = {
      ...ENTITLEMENTS,
      features: [
        row('base', true),
        row('till', false, { enabled: true }),
        row('till.tax', false),
        row('stock', true),
      ],
    };
    api({
      'GET /feature-catalog': [json(CATALOG)],
      [`GET /customers/${ID}/entitlements`]: [json(custom)],
    });
    renderCard();
    await user.click(await screen.findByTestId('modules-change-plan'));
    const dialog = await screen.findByTestId('plan-dialog');
    expect(within(dialog).getByTestId('plan-kept').textContent).toMatch(
      'fake.till.name stays On (custom)',
    );
  });
});
