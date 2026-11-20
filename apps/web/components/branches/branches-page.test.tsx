// @vitest-environment jsdom
import {
  systemRolePermissions,
  type SystemRole,
  type TeamMember,
  type Warehouse,
} from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BranchesPage, supplierOf } from './branches-page';
import { BranchesRoute } from './branches-route';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

/** The partner brand's menu: AsiaMight's is the operations one. */
const brand = vi.hoisted(() => ({ layout: 'operations' }));
vi.mock('../theme-provider', () => ({ useNavLayout: () => brand.layout }));

beforeEach(() => {
  resetMocks();
  brand.layout = 'operations';
});
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000056${String(n).padStart(2, '0')}`;
const HAGELBERGER = {
  id: id(1),
  name: 'Asia Might Hagelberger',
  brandId: id(90),
  address: 'Hagelberger Straße 57',
  archivedAt: null,
};
const KURFUERSTEN = {
  id: id(2),
  name: 'Asia Might Kurfürstenstraße',
  brandId: id(90),
  address: null,
  archivedAt: null,
};
const OLD = {
  id: id(3),
  name: 'Old Market',
  brandId: id(90),
  address: 'Marktplatz 1',
  archivedAt: '2026-11-01T10:00:00.000Z',
};
/** A warehouse's own place (ADR 0068): not listed as a branch. */
const DEPOT = {
  id: id(4),
  name: 'North Depot',
  brandId: id(90),
  address: null,
  archivedAt: null,
  isWarehouseSite: true,
};

const roleRef = (key: SystemRole, n: number) => ({ id: id(40 + n), systemKey: key, name: null });
const member = (n: number, over: Partial<TeamMember>): TeamMember => ({
  membershipId: id(60 + n),
  userId: id(70 + n),
  name: `Person ${n}`,
  email: `p${n}@example.test`,
  phone: null,
  role: roleRef('branch', 1),
  allLocations: false,
  locationIds: [],
  warehouseIds: [],
  grants: [],
  denies: [],
  permissions: [],
  status: 'active',
  lastActiveAt: null,
  joinedAt: '2026-11-01T10:00:00.000Z',
  passwordChangePending: false,
  passwordSettable: false,
  ...over,
});
const TEAM = {
  members: [
    member(1, { name: 'Dila', locationIds: [HAGELBERGER.id] }),
    member(2, { name: 'Nidheesh', locationIds: [KURFUERSTEN.id] }),
    // Everywhere: not listed on each card.
    member(3, { name: 'Owner', role: roleRef('owner', 2), allLocations: true }),
    // Switched off: not listed.
    member(4, { name: 'Former', locationIds: [HAGELBERGER.id], status: 'inactive' }),
  ],
  invitations: [],
  stats: { total: 4, active: 3, inactive: 1, invited: 0, customPermissions: 0 },
};
const warehouse = (n: number, locationId: string, extra: Record<string, unknown> = {}) => ({
  id: id(20 + n),
  locationId,
  name: `Store ${n}`,
  sortOrder: 0,
  suppliesStation: null,
  suppliesLocationIds: [],
  isTransit: false,
  isMain: false,
  archivedAt: null,
  ...extra,
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['inventory', 'orders'],
  });
}

/** Answers the page's reads; records the writes and answers them with what they would return. */
function api(approval = true, warehouses?: unknown[]) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body: unknown = init?.body ? JSON.parse(init.body as string) : null;
      writes.push({ method, path: input, body });
      if (input.startsWith('/api/v1/settings/')) {
        return Promise.resolve(
          Response.json({
            key: 'orders.requestsNeedApproval',
            value: (body as { value: boolean }).value,
            source: 'organization',
            dataBound: false,
          }),
        );
      }
      if (method === 'POST') {
        return Promise.resolve(
          Response.json(
            { id: id(9), brandId: id(90), archivedAt: null, address: null, ...(body as object) },
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(Response.json({ ...HAGELBERGER, ...(body as object) }));
    }
    const answers: Record<string, unknown> = {
      '/api/v1/locations?includeArchived=true': { data: [HAGELBERGER, KURFUERSTEN, OLD, DEPOT] },
      '/api/v1/staff': TEAM,
      '/api/v1/inventory/warehouses': {
        data: warehouses ?? [
          // The main warehouse supplies every branch it does not share with a ticked warehouse.
          warehouse(1, HAGELBERGER.id, { isMain: true }),
          warehouse(2, KURFUERSTEN.id),
          // Supplies Kurfürstenstraße (ADR 0067).
          warehouse(3, KURFUERSTEN.id, { suppliesLocationIds: [KURFUERSTEN.id] }),
          // Archived: supplies nobody, so it does not count.
          warehouse(4, KURFUERSTEN.id, {
            archivedAt: '2026-11-02T10:00:00.000Z',
            suppliesLocationIds: [KURFUERSTEN.id],
          }),
          warehouse(5, HAGELBERGER.id, { isTransit: true }),
        ],
      },
      '/api/v1/settings': {
        data: [
          {
            key: 'orders.requestsNeedApproval',
            value: approval,
            source: 'default',
            dataBound: false,
          },
        ],
      },
    };
    return Promise.resolve(Response.json(answers[input] ?? { data: [] }));
  });
  return writes;
}

const card = async (name: string) =>
  (await screen.findAllByTestId('branch-card')).find((c) => c.dataset.name === name)!;

describe('/branches (ADR 0056)', () => {
  it('shows each branch with its address and the staff limited to it, not warehouse places', async () => {
    signedInAs('owner');
    api();
    render(<BranchesPage />);
    const cards = await screen.findAllByTestId('branch-card');
    // The archived one only on request.
    expect(cards.map((c) => c.dataset.name)).toEqual([HAGELBERGER.name, KURFUERSTEN.name]);

    const hagel = await card(HAGELBERGER.name);
    expect(within(hagel).getByTestId('branch-address').textContent).toBe('Hagelberger Straße 57');
    await waitFor(() =>
      expect(
        within(hagel)
          .getAllByTestId('branch-staff-member')
          .map((m) => m.textContent),
      ).toEqual(['DilaBranch manager']),
    );
    expect(within(hagel).getByTestId('branch-staff').textContent).toContain('Staff (1)');

    const kurf = await card(KURFUERSTEN.name);
    expect(within(kurf).getByTestId('branch-address').textContent).toBe('No address yet');
    // Each card links to its warehouses; a warehouse's own place (ADR 0068) is no branch and has no card.
    expect(within(kurf).getByTestId('branch-warehouses').getAttribute('href')).toBe(
      '/inventory/warehouses',
    );
    expect(cards.map((c) => c.dataset.name)).not.toContain(DEPOT.name);
  });

  it('searches by name or address, and shows archived branches on request', async () => {
    signedInAs('owner');
    api();
    render(<BranchesPage />);
    await screen.findAllByTestId('branch-card');
    await userEvent.type(screen.getByTestId('branches-search'), 'hagelberger str');
    expect(screen.getAllByTestId('branch-card').map((c) => c.dataset.name)).toEqual([
      HAGELBERGER.name,
    ]);
    await userEvent.clear(screen.getByTestId('branches-search'));
    await userEvent.click(screen.getByTestId('branches-show-archived'));
    const old = await card(OLD.name);
    expect(within(old).getByTestId('branch-archived')).toBeTruthy();
    expect(within(old).getByTestId('branch-restore')).toBeTruthy();
    await userEvent.type(screen.getByTestId('branches-search'), 'zzz');
    expect(screen.getByText('No branches match.')).toBeTruthy();
  });

  it('adds a branch with its address, edits the address and archives a branch', async () => {
    signedInAs('owner');
    const writes = api();
    render(<BranchesPage />);
    await screen.findAllByTestId('branch-card');

    await userEvent.click(screen.getByTestId('branch-create'));
    await userEvent.type(await screen.findByTestId('branch-name'), 'Asia Might Mitte');
    await userEvent.type(screen.getByTestId('branch-address-input'), 'Torstraße 1');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes.find((w) => w.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/v1/locations',
        body: { name: 'Asia Might Mitte', address: 'Torstraße 1' },
      }),
    );

    const kurf = await card(KURFUERSTEN.name);
    await userEvent.click(within(kurf).getByTestId('branch-edit'));
    await userEvent.type(await screen.findByTestId('branch-address-input'), 'Kurfürstenstraße 33');
    await userEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(writes.find((w) => w.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: `/api/v1/locations/${KURFUERSTEN.id}`,
        body: { address: 'Kurfürstenstraße 33' },
      }),
    );

    const hagel = await card(HAGELBERGER.name);
    await userEvent.click(within(hagel).getByTestId('branch-archive'));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }),
    );
    await waitFor(() =>
      expect(writes.filter((w) => w.method === 'PATCH').at(-1)).toEqual({
        method: 'PATCH',
        path: `/api/v1/locations/${HAGELBERGER.id}`,
        body: { archived: true },
      }),
    );
  });

  it('switches whether stock transfers need approval', async () => {
    signedInAs('owner');
    const writes = api(true);
    render(<BranchesPage />);
    const toggle = await screen.findByTestId('branches-approval-toggle');
    expect(toggle.textContent).toBe('Required');
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(writes.find((w) => w.path.startsWith('/api/v1/settings/'))).toEqual({
        method: 'PUT',
        path: '/api/v1/settings/orders.requestsNeedApproval',
        body: { value: false },
      }),
    );
    await waitFor(() => expect(toggle.textContent).toBe('Not required'));
    expect(screen.getByTestId('branches-approval').textContent).toContain(
      'Transfers are dispatched as soon as they are submitted',
    );
  });

  it('is read only for a branch manager', async () => {
    signedInAs('branch');
    api(false);
    render(<BranchesPage />);
    await screen.findAllByTestId('branch-card');
    expect(screen.queryByTestId('branch-create')).toBeNull();
    expect(screen.queryByTestId('branch-edit')).toBeNull();
    expect(screen.queryByTestId('branch-archive')).toBeNull();
    const toggle = await screen.findByTestId('branches-approval-toggle');
    expect(toggle).toHaveProperty('disabled', true);
  });
});

describe('/branches shows the supplying warehouse (ADR 0067)', () => {
  it('links each branch to its connected warehouses: its own store and its supplier', async () => {
    signedInAs('owner');
    api();
    render(<BranchesPage />);
    // Kurfürstenstraße: its own store (Store 2) and the one that supplies it (Store 3); archived Store 4 is left out.
    expect(
      within(await card('Asia Might Kurfürstenstraße')).getByTestId('branch-warehouses')
        .textContent,
    ).toBe('2 warehouses');
    // Hagelberger: the main warehouse is its own store too, and the transit one is left out.
    expect(
      within(await card('Asia Might Hagelberger')).getByTestId('branch-warehouses').textContent,
    ).toBe('1 warehouse');
  });

  it('names the warehouse that ticks each branch, else the main warehouse, skipping archived ones', async () => {
    signedInAs('owner');
    api();
    render(<BranchesPage />);
    expect(
      within(await card('Asia Might Kurfürstenstraße')).getByTestId('branch-supplier').textContent,
    ).toBe('Supplied by Store 3');
    expect(
      within(await card('Asia Might Hagelberger')).getByTestId('branch-supplier').textContent,
    ).toBe('Supplied by Store 1 (main warehouse)');
  });

  it('lists the branches still without a supplier, with a link to set one', async () => {
    signedInAs('owner');
    // No main warehouse and nothing ticked: both branches need a supplier.
    api(true, [warehouse(2, KURFUERSTEN.id)]);
    render(<BranchesPage />);
    const missing = await screen.findByTestId('branches-suppliers-missing');
    expect(missing.textContent).toBe('Branches without a supplying warehouse: 2.');
    const link = within(await card('Asia Might Kurfürstenstraße')).getByTestId(
      'branch-choose-supplier',
    );
    expect(link.getAttribute('href')).toBe('/inventory/warehouses');
  });

  it('finds no supplier when no warehouse ticks the branch and there is no main one', () => {
    const none = [warehouse(1, HAGELBERGER.id)] as unknown as Warehouse[];
    expect(supplierOf(none, KURFUERSTEN.id)).toBeNull();
  });
});

describe('/branches only with the operations menu (ADR 0056)', () => {
  it('shows the Branches page in the operations menu, the plain locations list elsewhere', async () => {
    signedInAs('owner');
    api();
    render(<BranchesRoute />);
    expect(await screen.findAllByTestId('branch-card')).toHaveLength(2);
    expect(screen.getByTestId('branches-approval')).toBeTruthy();

    cleanup();
    brand.layout = 'default';
    render(<BranchesRoute />);
    await waitFor(() => expect(screen.queryByTestId('branch-card')).toBeNull());
    expect(screen.queryByTestId('branches-approval')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Branches' })).toBeTruthy();
  });
});
