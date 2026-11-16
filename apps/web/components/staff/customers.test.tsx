// @vitest-environment jsdom
import { STAFF_ROLE_PERMISSIONS, type StaffRole } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { CustomersPage, OnboardPage } from './customers';
import { activeHref, PortalShell } from './portal-shell';
import { StaffSessionProvider } from './staff-session';

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

type Answer = () => Response;
const calls: { key: string; body: unknown; idempotencyKey: string | null }[] = [];

/** Answers staff api calls by `METHOD path`; an array answers successive calls in order. */
function api(answers: Record<string, Answer | Answer[]>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${input.replace('/api/v1/platform', '')}`;
      calls.push({
        key,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
        idempotencyKey: new Headers(init?.headers).get('Idempotency-Key'),
      });
      const answer = answers[key];
      const fn = Array.isArray(answer) ? (answer.shift() ?? answer.at(-1)) : answer;
      return Promise.resolve(fn ? fn() : Response.json({ code: 'unknown' }, { status: 500 }));
    }),
  );
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const me = (role: StaffRole) =>
  json({
    id: '0190a000-0000-7000-8000-000000000001',
    email: 'me@durby.tech',
    role,
    permissions: STAFF_ROLE_PERMISSIONS[role],
    freshUntil: null,
  });
const PARTNER = { id: '0190a000-0000-7000-8000-0000000000a1', slug: 'durby', name: 'Durby' };
const OPTIONS = json({
  partners: [PARTNER],
  defaultPartnerId: PARTNER.id,
  plans: ['inventory', 'inventory_billing', 'full'],
});
const CUSTOMER = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  name: 'Cafe Nord',
  partner: PARTNER,
  plan: 'full',
  createdAt: '2026-10-29T10:00:00.000Z',
  owner: { email: 'owner@cafe-nord.test', status: 'invited' },
};

beforeEach(resetMocks);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withSession = (ui: ReactNode) => render(<StaffSessionProvider>{ui}</StaffSessionProvider>);

async function fill(name: string, email: string) {
  await userEvent.type(await screen.findByTestId('onboard-name'), name);
  await userEvent.type(screen.getByTestId('onboard-email'), email);
}

describe('onboard a customer', () => {
  it('needs a name and an owner email before sending anything', async () => {
    api({ 'GET /auth/me': me('onboarding'), 'GET /onboarding-options': OPTIONS });
    withSession(<OnboardPage />);
    await userEvent.click(await screen.findByTestId('onboard-submit'));
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual(['Enter the organization name.', 'Enter the owner email.']);
    expect(calls.map((c) => c.key)).not.toContain('POST /customers');
  });

  it('creates with defaults and shows who was invited', async () => {
    api({
      'GET /auth/me': me('onboarding'),
      'GET /onboarding-options': OPTIONS,
      'POST /customers': json(CUSTOMER, 201),
    });
    withSession(<OnboardPage />);
    await fill('Cafe Nord', 'owner@cafe-nord.test');
    await userEvent.click(screen.getByTestId('onboard-submit'));
    const done = await screen.findByTestId('onboard-done');
    expect(done.textContent).toContain('Cafe Nord is ready');
    expect(done.textContent).toContain(
      'An invitation for owner@cafe-nord.test was created and is being emailed.',
    );
    const post = calls.find((c) => c.key === 'POST /customers')!;
    expect(post.body).toEqual({
      name: 'Cafe Nord',
      ownerEmail: 'owner@cafe-nord.test',
      ownerLocale: 'en',
      plan: 'full',
      partnerId: PARTNER.id,
      confirmDuplicates: false,
    });
    expect(post.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Step 1d: modules pre-ticked from the plan; only the differences are sent.
  it('sends the modules that differ from the plan, keeping the set without gaps', async () => {
    const catalog = {
      modules: [
        {
          key: 'catalog',
          label: 'platform.features.catalog.name',
          description: 'x',
          dependsOn: [],
          order: 10,
          limits: [],
          features: [],
        },
        {
          key: 'pos',
          label: 'platform.features.pos.name',
          description: 'x',
          dependsOn: ['catalog'],
          order: 20,
          limits: [],
          features: [
            {
              key: 'pos.fiscal',
              label: 'platform.features.posFiscal.name',
              description: 'x',
              dependsOn: ['pos'],
              order: 1,
              limits: [],
            },
          ],
        },
        {
          key: 'inventory',
          label: 'platform.features.inventory.name',
          description: 'x',
          dependsOn: [],
          order: 30,
          limits: [],
          features: [],
        },
      ],
      plans: [
        { key: 'inventory', label: 'platform.plans.inventory', features: ['catalog', 'inventory'] },
        {
          key: 'inventory_billing',
          label: 'platform.plans.inventoryBilling',
          features: ['catalog', 'inventory'],
        },
        {
          key: 'full',
          label: 'platform.plans.full',
          features: ['catalog', 'pos', 'pos.fiscal', 'inventory'],
        },
      ],
    };
    api({
      'GET /auth/me': me('onboarding'),
      'GET /onboarding-options': OPTIONS,
      'GET /feature-catalog': json(catalog),
      'POST /customers': json(CUSTOMER, 201),
    });
    withSession(<OnboardPage />);
    await fill('Cafe Nord', 'owner@cafe-nord.test');
    const modules = await screen.findByTestId('onboard-modules');
    // Pre-ticked from Full.
    const box = (key: string) =>
      within(within(modules).getByTestId(`module-${key}`)).getByRole('checkbox');
    expect(box('inventory').getAttribute('data-state')).toBe('checked');
    // Unticking the catalog unticks what needs it, with a note.
    await userEvent.click(box('catalog'));
    expect(modules.textContent).toContain('Also switched off: Point of sale');
    // Ticking the fiscal sub-feature ticks POS and the catalog again.
    await userEvent.click(box('pos.fiscal'));
    await userEvent.click(box('inventory'));
    await userEvent.click(screen.getByTestId('onboard-submit'));
    await screen.findByTestId('onboard-done');
    expect(calls.find((c) => c.key === 'POST /customers')?.body).toMatchObject({
      plan: 'full',
      features: { inventory: false },
    });
  });

  it('retries an unanswered create with the same Idempotency-Key, and takes a new one when the form changes', async () => {
    const lost = () => {
      throw new TypeError('network down');
    };
    api({
      'GET /auth/me': me('onboarding'),
      'GET /onboarding-options': OPTIONS,
      'POST /customers': [lost, lost, json(CUSTOMER, 201)],
    });
    withSession(<OnboardPage />);
    await fill('Cafe Nord', 'owner@cafe-nord.test');
    await userEvent.click(screen.getByTestId('onboard-submit'));
    await waitFor(() => expect(calls.filter((c) => c.key === 'POST /customers')).toHaveLength(1));
    // Unknown outcome: the form stays, not loading, with the generic error.
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>('onboard-submit').disabled).toBe(false),
    );

    // Same data again: the customer may exist already, so the api must see the same key.
    await userEvent.click(screen.getByTestId('onboard-submit'));
    await waitFor(() => expect(calls.filter((c) => c.key === 'POST /customers')).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>('onboard-submit').disabled).toBe(false),
    );

    // A different request gets a different key.
    await userEvent.type(screen.getByTestId('onboard-name'), ' Sued');
    await userEvent.click(screen.getByTestId('onboard-submit'));
    await screen.findByTestId('onboard-done');
    const keys = calls.filter((c) => c.key === 'POST /customers').map((c) => c.idempotencyKey);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('warns about a known owner, then creates on confirmation', async () => {
    api({
      'GET /auth/me': me('super_admin'),
      'GET /onboarding-options': OPTIONS,
      'POST /customers': [
        json(
          {
            code: 'staff.customer_duplicate',
            details: { nameTaken: false, ownerHasAccount: true },
          },
          409,
        ),
        json({ ...CUSTOMER, owner: { ...CUSTOMER.owner, status: 'active' } }, 201),
      ],
    });
    withSession(<OnboardPage />);
    await fill('Cafe Nord', 'owner@cafe-nord.test');
    await userEvent.click(screen.getByTestId('onboard-submit'));
    const warning = await screen.findByTestId('onboard-duplicate');
    expect(warning.textContent).toContain('This email already has an account.');
    expect(warning.textContent).not.toContain('A customer with this name already exists.');
    await userEvent.click(within(warning).getByTestId('onboard-confirm'));
    await screen.findByTestId('onboard-done');
    const posts = calls.filter((c) => c.key === 'POST /customers');
    expect(posts.map((p) => (p.body as { confirmDuplicates: boolean }).confirmDuplicates)).toEqual([
      false,
      true,
    ]);
    expect(posts[0]?.idempotencyKey).not.toBe(posts[1]?.idempotencyKey);
  });

  it('is not offered to support staff', async () => {
    api({ 'GET /auth/me': me('support'), 'GET /onboarding-options': OPTIONS });
    withSession(<OnboardPage />);
    expect(await screen.findByTestId('staff-no-access')).toBeTruthy();
    expect(calls.map((c) => c.key)).not.toContain('GET /onboarding-options');
  });
});

describe('customers', () => {
  it('lists customers and searches by name', async () => {
    api({
      'GET /auth/me': me('support'),
      'GET /customers': json({ data: [CUSTOMER] }),
      'GET /customers?query=nord': json({ data: [] }),
    });
    withSession(<CustomersPage />);
    const row = await screen.findByTestId('customer-row');
    expect(row.textContent).toContain('Cafe Nord');
    expect(row.textContent).toContain('Full');
    expect(screen.queryByTestId('customers-onboard')).toBeNull(); // support can't onboard
    await userEvent.type(screen.getByTestId('customers-search'), 'nord{Enter}');
    expect(await screen.findByText('No customer matches.')).toBeTruthy();
  });
});

describe('sidebar', () => {
  it('shows the pages of the role, grouped', async () => {
    api({ 'GET /auth/me': me('support') });
    mockState.pathname = '/platform/customers';
    withSession(<PortalShell>content</PortalShell>);
    const sidebar = await screen.findByTestId('staff-sidebar');
    await waitFor(() =>
      expect(
        within(sidebar)
          .getAllByTestId('staff-nav-item')
          .map((a) => a.textContent),
      ).toEqual(['Home', 'Customers', 'Feedback']),
    );
    expect(
      within(sidebar).getByText('Customers', { selector: 'a' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('marks the most specific page as current', () => {
    expect(activeHref('/platform')).toBe('/platform');
    expect(activeHref('/platform/customers')).toBe('/platform/customers');
    expect(activeHref('/platform/customers/new')).toBe('/platform/customers/new');
    expect(activeHref('/platform/customers/0190a000-0000-7000-8000-0000000000c1')).toBe(
      '/platform/customers',
    );
  });
});
