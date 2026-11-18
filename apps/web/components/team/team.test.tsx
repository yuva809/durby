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
import { ChoosePassword } from '../auth/choose-password';
import { TeamPage } from './team-page';

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

const ME = '0190a000-0000-7000-8000-000000000001';
const id = (n: number) => `0190a000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;

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
  role('waiter', 4),
  role('cashier', 5),
];
const ref = (r: Role) => ({ id: r.id, systemKey: r.systemKey, name: r.name });
const WAITER = ROLES[3]!;

const teamMember = (n: number, over: Partial<TeamMember> = {}): TeamMember => ({
  membershipId: id(60 + n),
  userId: id(70 + n),
  name: `Person ${n}`,
  email: `p${n}@example.test`,
  phone: null,
  role: ref(WAITER),
  allLocations: true,
  locationIds: [],
  grants: [],
  denies: [],
  permissions: WAITER.permissions,
  status: 'active',
  lastActiveAt: null,
  joinedAt: '2026-11-01T10:00:00.000Z',
  passwordChangePending: false,
  passwordSettable: false,
  ...over,
});

const TEAM: TeamListResponse = {
  members: [
    teamMember(1, {
      name: 'Rabindra Thanet',
      phone: '9887809998',
      grants: ['catalog.products.edit'],
      denies: ['pos.bills.print'],
    }),
    teamMember(2, { name: 'Kritish Devkota', status: 'inactive' }),
    teamMember(3, {
      userId: ME,
      name: 'Me Owner',
      role: ref(ROLES[0]!),
      permissions: ROLES[0]!.permissions,
    }),
  ],
  invitations: [
    {
      invitationId: id(90),
      name: 'Arun',
      email: 'arun@example.test',
      phone: null,
      role: ref(WAITER),
      allLocations: true,
      locationIds: [],
      grants: [],
      denies: [],
      expiresAt: '2026-11-10T10:00:00.000Z',
      createdAt: '2026-11-03T10:00:00.000Z',
    },
  ],
  stats: { total: 3, active: 2, inactive: 1, invited: 1, customPermissions: 1 },
};

function signedInAs(key: SystemRole, activeFeatures = ['catalog', 'pos']) {
  const r = ROLES.find((x) => x.systemKey === key)!;
  mockState.session = sessionFixture({
    user: { id: ME, email: 'me@example.test', locale: 'en' },
    activeRole: ref(r),
    activePermissions: [...systemRolePermissions(key)],
    activeFeatures,
  });
}

/** Answers by method and path (`gets` before the defaults); records the writes. */
function api(writes: Record<string, () => Response> = {}, gets: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      sent.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      const answer = writes[`${method} ${path}`];
      return Promise.resolve(answer ? answer() : new Response(null, { status: 204 }));
    }
    if (path in gets) return Promise.resolve(Response.json(gets[path]));
    if (path === '/api/v1/staff') return Promise.resolve(Response.json(TEAM));
    if (path === '/api/v1/roles') return Promise.resolve(Response.json({ data: ROLES }));
    return Promise.resolve(Response.json({ data: [] }));
  });
  return sent;
}

describe('TeamPage', () => {
  it('shows the stats, members with their changes and the open invitations', async () => {
    signedInAs('owner');
    api();
    render(<TeamPage />);
    const stats = await screen.findByTestId('team-stats');
    expect(stats.textContent).toContain('3');
    const rows = await screen.findAllByTestId('team-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByTestId('team-chips').textContent).toMatch(/No /);
    expect(within(rows[1]!).getByTestId('team-status').textContent).toBe('Inactive');
    expect(screen.getAllByTestId('team-invitation-row')).toHaveLength(1);
    // No actions on yourself.
    expect(within(rows[2]!).queryByTestId('team-row-menu')).toBeNull();
  });

  it('has the roles as a tab of Manage Staff for holders of platform.roles.read', async () => {
    signedInAs('owner');
    api();
    render(<TeamPage />);
    await screen.findAllByTestId('team-row');
    await userEvent.click(screen.getByTestId('team-tab-roles'));
    expect((await screen.findAllByTestId('role-card')).length).toBe(ROLES.length);
    expect(screen.queryByTestId('team-row')).toBeNull();
    await userEvent.click(screen.getByTestId('team-tab-members'));
    expect(await screen.findAllByTestId('team-row')).toHaveLength(3);
  });

  it('filters by status and search', async () => {
    signedInAs('owner');
    api();
    render(<TeamPage />);
    await screen.findAllByTestId('team-row');
    await userEvent.selectOptions(screen.getByTestId('team-status-filter'), 'invited');
    expect(screen.queryAllByTestId('team-row')).toHaveLength(0);
    expect(screen.getAllByTestId('team-invitation-row')).toHaveLength(1);
    await userEvent.selectOptions(screen.getByTestId('team-status-filter'), 'all');
    await userEvent.type(screen.getByTestId('team-search'), '9887809');
    expect(screen.getAllByTestId('team-row')).toHaveLength(1);
  });

  it('adds someone with a temporary password and a changed permission', async () => {
    signedInAs('owner');
    const sent = api({
      'POST /api/v1/staff': () =>
        Response.json({ kind: 'created', membershipId: id(99) }, { status: 201 }),
    });
    render(<TeamPage />);
    await userEvent.click(await screen.findByTestId('team-add'));
    const dialog = await screen.findByTestId('team-dialog');
    await userEvent.type(within(dialog).getByTestId('team-name'), 'Ravi Kumar');
    await userEvent.type(within(dialog).getByTestId('team-email'), 'ravi@example.test');
    await userEvent.type(within(dialog).getByTestId('team-phone'), '+49 151 1234567');
    await userEvent.click(within(dialog).getByTestId('team-generate'));
    const waiter = within(dialog)
      .getAllByTestId('team-role')
      .find((b) => b.dataset.role === 'waiter')!;
    await userEvent.click(waiter);
    const box = (key: string) =>
      within(dialog)
        .getAllByTestId('team-permission')
        .find((c) => c.dataset.key === key)!;
    await userEvent.click(box('pos.bills.print'));
    await userEvent.click(box('catalog.products.edit'));
    expect(within(dialog).getAllByTestId('team-permission-changed')).toHaveLength(2);
    await userEvent.click(within(dialog).getByTestId('team-save'));

    expect(await screen.findByTestId('team-result')).toBeDefined();
    const post = sent.find((s) => s.path === '/api/v1/staff')!;
    expect(post.body).toMatchObject({
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      phone: '+49 151 1234567',
      roleId: WAITER.id,
      locationIds: null,
      grants: ['catalog.products.edit'],
      denies: ['pos.bills.print'],
      sendEmail: false,
    });
    expect((post.body as { temporaryPassword: string }).temporaryPassword).toHaveLength(12);
    // Language left on the organization's: the api picks it.
    expect(post.body).not.toHaveProperty('locale');
    // Typing three fields key by key and the full matrix: ~4 s alone, past 15 s when the whole suite runs at once.
  }, 30_000);

  it('invites without a password and shares the link on WhatsApp', async () => {
    signedInAs('owner');
    const link = 'https://app.test/accept-invite#token=abc';
    const sent = api({
      'POST /api/v1/staff': () =>
        Response.json(
          { kind: 'invited', invitationId: id(91), existingAccount: true },
          { status: 201 },
        ),
      [`POST /api/v1/invitations/${id(91)}/link`]: () => Response.json({ link }),
    });
    render(<TeamPage />);
    await userEvent.click(await screen.findByTestId('team-add'));
    const dialog = await screen.findByTestId('team-dialog');
    await userEvent.type(within(dialog).getByTestId('team-name'), 'Mina');
    await userEvent.type(within(dialog).getByTestId('team-email'), 'mina@example.test');
    await userEvent.selectOptions(within(dialog).getByTestId('team-locale'), 'de');
    await userEvent.click(within(dialog).getByTestId('team-save'));
    const result = await screen.findByTestId('team-result');
    expect(sent.find((s) => s.path === '/api/v1/staff')?.body).toMatchObject({ locale: 'de' });
    expect(result.textContent).toContain('already has an account');
    await userEvent.click(within(result).getByTestId('team-get-link'));
    await waitFor(() => expect(screen.getByTestId<HTMLInputElement>('team-link').value).toBe(link));
    expect(screen.getByTestId('team-whatsapp').getAttribute('href')).toContain(
      encodeURIComponent(link),
    );
  });

  it('locks the permissions a manager does not hold', async () => {
    signedInAs('manager');
    api();
    render(<TeamPage />);
    await userEvent.click(await screen.findByTestId('team-add'));
    const dialog = await screen.findByTestId('team-dialog');
    const box = (key: string) =>
      within(dialog)
        .getAllByTestId('team-permission')
        .find((c) => c.dataset.key === key)!;
    expect(box('catalog.products.edit').hasAttribute('disabled')).toBe(true);
    expect(box('pos.bills.print').hasAttribute('disabled')).toBe(false);
    // Reservations are switched off for this organization: not listed.
    expect(dialog.textContent).toContain('switched off');
  });

  it('shows create, edit and delete as columns and ticks a whole area at once (ADR 0037)', async () => {
    signedInAs('owner');
    api();
    render(<TeamPage />);
    await userEvent.click(await screen.findByTestId('team-add'));
    const dialog = await screen.findByTestId('team-dialog');
    const waiter = within(dialog)
      .getAllByTestId('team-role')
      .find((b) => b.dataset.role === 'waiter')!;
    await userEvent.click(waiter);
    const row = within(dialog)
      .getAllByTestId('team-matrix-row')
      .find((r) => r.dataset.area === 'catalog.products')!;
    const keys = within(row)
      .getAllByTestId('team-permission')
      .map((c) => c.dataset.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'catalog.products.create',
        'catalog.products.edit',
        'catalog.products.delete',
      ]),
    );
    const whole = within(row).getByTestId('team-permission-area');
    await userEvent.click(whole);
    for (const box of within(row).getAllByTestId('team-permission')) {
      expect(box.getAttribute('data-state')).toBe('checked');
    }
    await userEvent.click(whole);
    for (const box of within(row).getAllByTestId('team-permission')) {
      expect(box.getAttribute('data-state')).toBe('unchecked');
    }
  });

  it('puts every permission in a View, Create, Edit or Delete cell, grouped by section (ADR 0050)', async () => {
    signedInAs('owner', ['catalog', 'pos', 'orders']);
    api();
    render(<TeamPage />);
    await userEvent.click(await screen.findByTestId('team-add'));
    const dialog = await screen.findByTestId('team-dialog');
    const waiter = within(dialog)
      .getAllByTestId('team-role')
      .find((b) => b.dataset.role === 'waiter')!;
    await userEvent.click(waiter);
    const sections = within(dialog).getAllByTestId('team-matrix-section');
    expect(sections.map((s) => s.dataset.section)).toEqual([
      'platform',
      'catalog',
      'pos',
      'orders',
    ]);
    expect(sections[0]!.textContent).toContain('Administration');

    // Picking: one box, in the Edit column, the sentence as its name; the other cells are dashes.
    const picking = within(dialog)
      .getAllByTestId('team-matrix-row')
      .find((r) => r.dataset.area === 'orders.picking')!;
    expect(picking.textContent).toContain('Picking');
    const box = within(picking).getByTestId('team-permission');
    expect(box.dataset.key).toBe('orders.picking.use');
    expect(box.closest('[data-column]')?.getAttribute('data-column')).toBe('edit');
    expect(box.getAttribute('aria-label')).toBe('Pick and pack sales orders');
    expect(within(picking).getAllByTestId('team-permission-empty')).toHaveLength(3);
    await userEvent.click(box);
    expect(box.getAttribute('data-state')).toBe('checked');

    // A box that allows more than its column says carries a note.
    const users = within(dialog)
      .getAllByTestId('team-matrix-row')
      .find((r) => r.dataset.area === 'platform.users')!;
    expect(within(users).getByTestId('team-permission-note')).toBeDefined();
    const manage = within(users)
      .getAllByTestId('team-permission')
      .find((c) => c.dataset.key === 'platform.users.manage')!;
    expect(manage.getAttribute('aria-label')).toContain('Also allows removing members.');

    // The section box: some ticked → indeterminate; click → all; click → none.
    const orders = sections.find((s) => s.dataset.section === 'orders')!;
    const whole = within(orders).getByTestId('team-permission-section');
    expect(whole.getAttribute('data-state')).toBe('indeterminate');
    await userEvent.click(whole);
    for (const cell of within(orders).getAllByTestId('team-permission'))
      expect(cell.getAttribute('data-state')).toBe('checked');
    await userEvent.click(whole);
    for (const cell of within(orders).getAllByTestId('team-permission'))
      expect(cell.getAttribute('data-state')).toBe('unchecked');
  });

  it('deactivates a member after confirming', async () => {
    signedInAs('owner');
    const sent = api({
      [`POST /api/v1/staff/${id(61)}/deactivate`]: () =>
        Response.json({ ...TEAM.members[0], status: 'inactive' }),
    });
    render(<TeamPage />);
    const rows = await screen.findAllByTestId('team-row');
    await userEvent.click(within(rows[0]!).getByTestId('team-row-menu'));
    await userEvent.click(await screen.findByTestId('team-deactivate'));
    await userEvent.click(await screen.findByTestId('team-confirm'));
    await waitFor(() =>
      expect(sent.map((s) => `${s.method} ${s.path}`)).toContain(
        `POST /api/v1/staff/${id(61)}/deactivate`,
      ),
    );
  });

  it('sets a password for a member this organization created; final where owners and admins set them', async () => {
    signedInAs('owner');
    const settable = { ...TEAM.members[0]!, passwordSettable: true };
    const sent = api(
      { [`POST /api/v1/staff/${id(61)}/password`]: () => Response.json(settable) },
      {
        '/api/v1/staff': { ...TEAM, members: [settable, ...TEAM.members.slice(1)] },
        '/api/v1/settings': {
          data: [
            { key: 'team.adminsManageSignIn', value: true, source: 'partner', dataBound: false },
          ],
        },
      },
    );
    render(<TeamPage />);
    const rows = await screen.findAllByTestId('team-row');
    await userEvent.click(within(rows[1]!).getByTestId('team-row-menu'));
    expect(screen.queryByTestId('team-set-password')).toBeNull();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(rows[0]!).getByTestId('team-row-menu'));
    await userEvent.click(await screen.findByTestId('team-set-password'));
    const dialog = await screen.findByTestId('team-password-dialog');
    expect(dialog.textContent).toContain('They sign in with this password from now on.');
    await userEvent.type(within(dialog).getByTestId('team-new-password'), 'short');
    await userEvent.click(within(dialog).getByTestId('team-new-password-save'));
    expect(await within(dialog).findByText(/at least 12 characters/)).toBeDefined();
    await userEvent.clear(within(dialog).getByTestId('team-new-password'));
    await userEvent.type(within(dialog).getByTestId('team-new-password'), 'a new password 42');
    await userEvent.click(within(dialog).getByTestId('team-new-password-save'));
    expect(await screen.findByTestId('team-password-done')).toBeDefined();
    expect(sent.find((s) => s.path.endsWith('/password'))).toEqual({
      method: 'POST',
      path: `/api/v1/staff/${id(61)}/password`,
      body: { password: 'a new password 42' },
    });
  });

  it('calls the password final when adding staff where owners and admins set passwords', async () => {
    signedInAs('owner');
    api(
      {},
      {
        '/api/v1/settings': {
          data: [
            {
              key: 'team.adminsManageSignIn',
              value: true,
              source: 'organization',
              dataBound: false,
            },
          ],
        },
      },
    );
    render(<TeamPage />);
    await screen.findAllByTestId('team-row');
    await userEvent.click(screen.getByTestId('team-add'));
    const dialog = await screen.findByTestId('team-dialog');
    await waitFor(() =>
      expect(dialog.textContent).toContain('only owners and admins can change it'),
    );
  });
});

describe('ChoosePassword', () => {
  it('checks the new password, then changes it through the session store', async () => {
    signedInAs('waiter');
    mockState.store.changePassword.mockResolvedValue({ ok: true });
    render(<ChoosePassword />);
    await userEvent.type(screen.getByTestId('choose-current'), 'temporary password 1');
    await userEvent.type(screen.getByTestId('choose-new'), 'my own password 9');
    await userEvent.type(screen.getByTestId('choose-repeat'), 'my own password 8');
    await userEvent.click(screen.getByTestId('choose-submit'));
    expect(await screen.findByText('The two new passwords don’t match.')).toBeDefined();
    expect(mockState.store.changePassword).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByTestId('choose-repeat'));
    await userEvent.type(screen.getByTestId('choose-repeat'), 'my own password 9');
    await userEvent.click(screen.getByTestId('choose-submit'));
    expect(mockState.store.changePassword).toHaveBeenCalledWith(
      'temporary password 1',
      'my own password 9',
    );
  });
});
