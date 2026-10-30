// @vitest-environment jsdom
import { type Role, type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { MembersPage } from './members-page';
import { RolesPage } from './roles-page';

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
const id = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(50), name: 'Main street', brandId: id(51) };

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
  role('staff', 4),
  { id: id(5), systemKey: null, name: 'Auditor', permissions: ['platform.audit.read'] },
];
const ref = (r: Role) => ({ id: r.id, systemKey: r.systemKey, name: r.name });
const member = (n: number, userId: string, email: string, r: Role) => ({
  id: id(60 + n),
  userId,
  email,
  role: ref(r),
  allLocations: true,
  locationIds: [],
});
const MEMBERS = [
  member(1, ME, 'me@example.test', ROLES[1]!),
  member(2, id(70), 'owner@example.test', ROLES[0]!),
  member(3, id(71), 'staff@example.test', ROLES[3]!),
];

function signedInAs(key: SystemRole) {
  const r = ROLES.find((x) => x.systemKey === key)!;
  mockState.session = sessionFixture({
    user: { id: ME, email: 'me@example.test', locale: 'en' },
    activeRole: ref(r),
    activePermissions: [...systemRolePermissions(key)],
  });
}

/** Answers by path, like the api would. */
function api(answers: Record<string, () => Response>) {
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const path = input.replace(/\?.*$/, '');
    const answer = answers[path];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
}

const defaults = {
  '/api/v1/members': () => Response.json({ data: MEMBERS }),
  '/api/v1/invitations': () => Response.json({ data: [] }),
  '/api/v1/roles': () => Response.json({ data: ROLES }),
  '/api/v1/locations': () => Response.json({ data: [LOCATION] }),
};

const rowOf = async (email: string) =>
  (await screen.findAllByTestId('member-row')).find((r) => r.dataset.email === email)!;

describe('nav for Owner, Manager and Staff', () => {
  const settingsItems = (key: SystemRole) =>
    visibleNav(SETTINGS_TABS, {
      activeFeatures: [],
      activePermissions: [...systemRolePermissions(key)],
    }).map((i) => i.id);

  it('shows the settings tabs by permission', () => {
    expect(settingsItems('owner')).toEqual([
      'organization',
      'locations',
      'members',
      'roles',
      'general',
      'numbering',
      'labels',
      'plan',
      'audit',
    ]);
    expect(settingsItems('manager')).toEqual([
      'organization',
      'locations',
      'members',
      'roles',
      'general',
      'numbering',
      'plan',
    ]);
    expect(settingsItems('staff')).toEqual([
      'organization',
      'locations',
      'general',
      'numbering',
      'plan',
    ]);
    expect(settingsItems('waiter')).toEqual(settingsItems('staff'));
  });
});

describe('MembersPage', () => {
  it('shows "not available" to Staff and loads nothing', () => {
    signedInAs('staff');
    render(<MembersPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });

  it('lists members with role and scope; no actions on yourself or, for an Admin, on Owners', async () => {
    signedInAs('admin');
    api(defaults);
    render(<MembersPage />);
    const me = await rowOf('me@example.test');
    expect(within(me).getByText('You')).toBeTruthy();
    expect(within(me).queryByTestId('member-change')).toBeNull();
    expect(within(me).queryByTestId('member-remove')).toBeNull();

    const owner = await rowOf('owner@example.test');
    expect(within(owner).getByTestId('member-role').textContent).toBe('Owner');
    expect(within(owner).queryByTestId('member-change')).toBeNull();

    const staff = await rowOf('staff@example.test');
    expect(within(staff).getByText('All locations')).toBeTruthy();
    expect(within(staff).getByTestId('member-change')).toBeTruthy();
    expect(within(staff).getByTestId('member-remove')).toBeTruthy();
  });

  it('offers a Manager no member actions (no platform.users.manage)', async () => {
    signedInAs('manager');
    api(defaults);
    render(<MembersPage />);
    const staff = await rowOf('staff@example.test');
    expect(within(staff).queryByTestId('member-change')).toBeNull();
  });

  it('offers only grantable roles in the change dialog', async () => {
    signedInAs('admin');
    api(defaults);
    render(<MembersPage />);
    await userEvent.click(within(await rowOf('staff@example.test')).getByTestId('member-change'));
    const options = within(await screen.findByTestId('role-select'))
      .getAllByRole('option')
      .filter((o) => !(o as HTMLOptionElement).disabled)
      .map((o) => o.textContent);
    expect(options).toEqual(['Admin', 'Manager', 'Staff', 'Auditor']);
  });

  it('shows the label of an api error in the dialog, not the code', async () => {
    signedInAs('owner');
    api({
      ...defaults,
      '/api/v1/members/0190a000-0000-7000-8000-000000000162': () =>
        Response.json({ code: 'rbac.last_owner', message: 'raw' }, { status: 409 }),
    });
    render(<MembersPage />);
    const owner = await rowOf('owner@example.test');
    await userEvent.click(within(owner).getByTestId('member-remove'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The organization needs at least one owner.');
    expect(document.body.textContent).not.toContain('rbac.last_owner');
  });

  it('shows the generic error with a retry when the list fails', async () => {
    signedInAs('admin');
    api({ ...defaults, '/api/v1/members': () => new Response('oops', { status: 500 }) });
    render(<MembersPage />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers no location choice when the organization has no locations', async () => {
    signedInAs('owner');
    api({ ...defaults, '/api/v1/locations': () => Response.json({ data: [] }) });
    render(<MembersPage />);
    await userEvent.click(within(await rowOf('staff@example.test')).getByTestId('member-change'));
    await screen.findByTestId('role-select');
    expect(screen.queryByTestId('scope-selected')).toBeNull();
  });

  it('locks Owner invitations to all locations', async () => {
    signedInAs('owner');
    api(defaults);
    render(<MembersPage />);
    await userEvent.click(await screen.findByTestId('tab-invitations'));
    await userEvent.click(await screen.findByTestId('invite-open'));
    await userEvent.selectOptions(await screen.findByTestId('role-select'), 'Owner');
    // Disabled through its fieldset.
    expect(screen.getByTestId('scope-selected').matches(':disabled')).toBe(true);
    expect(screen.getByText('Owners always have access to all locations.')).toBeTruthy();
  });
});

describe('InviteDialog with a stalled request', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stops loading and shows the error when the write times out, then retries with the same key', async () => {
    signedInAs('owner');
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const posts: RequestInit[] = [];
    mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
      const path = input.replace(/\?.*$/, '');
      if (init?.method !== 'POST')
        return Promise.resolve(
          Response.json({
            data: path === '/api/v1/roles' ? ROLES : path === '/api/v1/locations' ? [LOCATION] : [],
          }),
        );
      posts.push(init);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('timeout', 'TimeoutError')),
        );
      });
    });
    render(<MembersPage />);
    await userEvent.click(await screen.findByTestId('tab-invitations'));
    await userEvent.click(await screen.findByTestId('invite-open'));
    await userEvent.type(await screen.findByLabelText('Email'), 'new@example.test');
    await userEvent.selectOptions(await screen.findByTestId('role-select'), 'Staff');
    await userEvent.click(screen.getByTestId('invite-send'));

    const send = screen.getByTestId('invite-send');
    await vi.waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(true));

    controller.abort();
    await vi.waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(0);

    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    await userEvent.click(screen.getByTestId('invite-send'));
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    const keyOf = (init: RequestInit) => new Headers(init.headers).get('Idempotency-Key');
    expect(keyOf(posts[1]!)).toBe(keyOf(posts[0]!));
  });
});

describe('RolesPage', () => {
  it('shows "not available" to Staff', () => {
    signedInAs('staff');
    render(<RolesPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('shows system roles read-only and no editor without platform.roles.manage', async () => {
    signedInAs('manager');
    api(defaults);
    render(<RolesPage />);
    const cards = await screen.findAllByTestId('role-card');
    expect(cards.map((c) => c.dataset.role)).toEqual([
      'Owner',
      'Admin',
      'Manager',
      'Staff',
      'Auditor',
    ]);
    expect(screen.queryByTestId('role-create')).toBeNull();
    expect(screen.queryByTestId('role-edit')).toBeNull();
    // Staff's location-scope keys: settings, products and tables.
    expect(within(cards[3]!).getAllByText('per location')).toHaveLength(3);
  });

  it('offers only held keys in the editor', async () => {
    signedInAs('admin');
    api(defaults);
    render(<RolesPage />);
    await userEvent.click(await screen.findByTestId('role-create'));
    const held = screen.getByTestId('permission-platform.users.manage');
    const notHeld = screen.getByTestId('permission-platform.org.manage');
    expect((held as HTMLButtonElement).disabled).toBe(false);
    expect((notHeld as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Your role doesn't include this")).toBeTruthy();
  });
});
