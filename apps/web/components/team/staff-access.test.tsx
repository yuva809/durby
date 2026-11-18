// @vitest-environment jsdom
import {
  type Role,
  type SystemRole,
  systemRolePermissions,
  type TeamListResponse,
  type TeamMember,
} from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { TeamPage } from './team-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

/** The partner brand's menu: AsiaMight's is the operations one. */
const brand = vi.hoisted(() => ({ layout: 'operations' }));
vi.mock('../theme-provider', () => ({ useNavLayout: () => brand.layout }));

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  resetMocks();
  brand.layout = 'operations';
});
afterEach(cleanup);

const ME = '0190a000-0000-7000-8000-000000000001';
const id = (n: number) => `0190a000-0000-7000-8000-0000000057${String(n).padStart(2, '0')}`;
const role = (key: SystemRole, n: number): Role => ({
  id: id(n),
  systemKey: key,
  name: null,
  permissions: [...systemRolePermissions(key)],
});
const ROLES: Role[] = [
  role('owner', 1),
  role('admin', 2),
  role('manager', 3),
  role('warehouse', 4),
];
const WAREHOUSE_ROLE = ROLES[3]!;
const ref = (r: Role) => ({ id: r.id, systemKey: r.systemKey, name: r.name });
const MAIN = { id: id(10), name: 'Main', brandId: id(90), address: null, archivedAt: null };
const BRANCH = { id: id(11), name: 'Branch', brandId: id(90), address: null, archivedAt: null };
const warehouse = (n: number, locationId: string, name: string, extra: object = {}) => ({
  id: id(20 + n),
  locationId,
  name,
  sortOrder: 0,
  suppliesStation: null,
  isTransit: false,
  isMain: false,
  archivedAt: null,
  ...extra,
});
const DRY = warehouse(1, MAIN.id, 'Dry store');
const COLD = warehouse(2, MAIN.id, 'Cold room');
const STORE = warehouse(3, BRANCH.id, 'Branch store');

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  membershipId: id(60),
  userId: id(70),
  name: 'Lager Lena',
  email: 'lena@example.test',
  phone: null,
  role: ref(WAREHOUSE_ROLE),
  allLocations: true,
  locationIds: [],
  warehouseIds: [],
  grants: [],
  denies: [],
  permissions: WAREHOUSE_ROLE.permissions,
  status: 'active',
  lastActiveAt: null,
  joinedAt: '2026-11-01T10:00:00.000Z',
  passwordChangePending: false,
  passwordSettable: false,
  ...over,
});

function api(team: TeamMember[]) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      sent.push({ method, path, body });
      return Promise.resolve(Response.json({ ...team[0], ...(body as object) }));
    }
    const answers: Record<string, unknown> = {
      '/api/v1/staff': {
        members: team,
        invitations: [],
        stats: { total: 1, active: 1, inactive: 0, invited: 0, customPermissions: 0 },
      } satisfies TeamListResponse,
      '/api/v1/roles': { data: ROLES },
      '/api/v1/locations': { data: [MAIN, BRANCH] },
      '/api/v1/inventory/warehouses': {
        data: [DRY, COLD, STORE, warehouse(4, MAIN.id, 'In transit', { isTransit: true })],
      },
    };
    return Promise.resolve(Response.json(answers[path] ?? { data: [] }));
  });
  return sent;
}

function signedInAsOwner() {
  mockState.session = sessionFixture({
    user: { id: ME, email: 'me@example.test', locale: 'en' },
    activeRole: ref(ROLES[0]!),
    activePermissions: [...systemRolePermissions('owner')],
    activeFeatures: ['inventory', 'orders'],
  });
}

async function editFirst() {
  const rows = await screen.findAllByTestId('team-row');
  await userEvent.click(within(rows[0]!).getByTestId('team-row-menu'));
  await userEvent.click(await screen.findByTestId('team-edit'));
  return screen.findByTestId('team-dialog');
}

describe('Branch Access and Warehouse Access (ADR 0057)', () => {
  it('limits a member to a branch and one of its warehouses; no tick is everywhere', async () => {
    signedInAsOwner();
    const sent = api([member()]);
    render(<TeamPage />);
    const dialog = await editFirst();
    const branchAccess = await within(dialog).findByTestId('team-branch-access');
    expect(branchAccess.textContent).toContain('No tick: every branch.');
    // No branch ticked: the warehouses of every branch, never the transit one.
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByTestId('team-warehouse')
          .map((w) => w.dataset.id),
      ).toEqual([DRY.id, COLD.id, STORE.id]),
    );

    await userEvent.click(
      within(branchAccess)
        .getAllByTestId('team-branch')
        .find((b) => b.dataset.id === MAIN.id)!,
    );
    // Only the chosen branch's warehouses now.
    const offered = within(dialog).getAllByTestId('team-warehouse');
    expect(offered.map((w) => w.dataset.id)).toEqual([DRY.id, COLD.id]);
    await userEvent.click(offered[0]!);
    await userEvent.click(within(dialog).getByTestId('team-save'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH')?.body).toMatchObject({
        locationIds: [MAIN.id],
        warehouseIds: [DRY.id],
      }),
    );
  });

  it('sends every branch and every warehouse when nothing is ticked', async () => {
    signedInAsOwner();
    const sent = api([
      member({ allLocations: false, locationIds: [MAIN.id], warehouseIds: [DRY.id] }),
    ]);
    render(<TeamPage />);
    const dialog = await editFirst();
    const branchAccess = await within(dialog).findByTestId('team-branch-access');
    await userEvent.click(
      within(branchAccess)
        .getAllByTestId('team-branch')
        .find((b) => b.dataset.id === MAIN.id)!,
    );
    await userEvent.click(
      within(dialog)
        .getAllByTestId('team-warehouse')
        .find((w) => w.dataset.id === DRY.id)!,
    );
    await userEvent.click(within(dialog).getByTestId('team-save'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH')?.body).toMatchObject({
        locationIds: null,
        warehouseIds: null,
      }),
    );
  });

  it('keeps the old location choice outside the operations menu, without warehouses', async () => {
    brand.layout = 'default';
    signedInAsOwner();
    api([member()]);
    render(<TeamPage />);
    const dialog = await editFirst();
    expect(await within(dialog).findByTestId('team-all-locations')).toBeTruthy();
    expect(within(dialog).queryByTestId('team-branch-access')).toBeNull();
    expect(within(dialog).queryByTestId('team-warehouse-access')).toBeNull();
  });
});
