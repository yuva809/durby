import { dictionaries, LOCALES } from '@durby/i18n';
import {
  type Invitation,
  type Member,
  PERMISSION_KEYS,
  type Role,
  type SystemRole,
  systemRolePermissions,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { sessionFixture } from '../../test/session-fixture';
import {
  areaLabel,
  canEditCustomRole,
  canOfferPermission,
  canRevokeInvitation,
  grantableRoles,
  memberActions,
  permissionGroups,
  permissionLabel,
  usersAccessOf,
} from './access';

const ME = '0190a000-0000-7000-8000-000000000001';
const OTHER = '0190a000-0000-7000-8000-000000000002';
const id = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

const systemRole = (key: SystemRole, n: number): Role => ({
  id: id(n),
  systemKey: key,
  name: null,
  permissions: [...systemRolePermissions(key)],
});
const ROLES: Role[] = [
  systemRole('owner', 1),
  systemRole('admin', 2),
  systemRole('manager', 3),
  systemRole('staff', 4),
  { id: id(5), systemKey: null, name: 'Auditor', permissions: ['platform.audit.read'] },
];
const role = (key: string) => ROLES.find((r) => (r.systemKey ?? r.name) === key)!;

/** The session's hints for a user with `key`'s role (its permissions, as the api reports them). */
const accessAs = (key: SystemRole) =>
  usersAccessOf(
    sessionFixture({
      activeRole: { id: role(key).id, systemKey: key, name: null },
      activePermissions: [...systemRolePermissions(key)],
    }),
  );

const member = (userId: string, roleKey: string): Member => {
  const r = role(roleKey);
  return {
    id: id(90),
    userId,
    email: 'm@example.test',
    role: { id: r.id, systemKey: r.systemKey, name: r.name },
    allLocations: true,
    locationIds: [],
  };
};

describe('usersAccessOf', () => {
  it('reads the page permissions from the session hints', () => {
    expect(accessAs('manager')).toMatchObject({
      canReadUsers: true,
      canInvite: true,
      canManageUsers: false,
      canReadRoles: true,
      canManageRoles: false,
    });
    expect(accessAs('staff')).toMatchObject({ canReadUsers: false, canReadRoles: false });
  });
});

describe('grantableRoles (role pickers)', () => {
  const names = (roles: Role[]) => roles.map((r) => r.systemKey ?? r.name);

  it('offers Owner only to Owners', () => {
    expect(names(grantableRoles(accessAs('owner'), ROLES))).toEqual([
      'owner',
      'admin',
      'manager',
      'staff',
      'Auditor',
    ]);
    expect(names(grantableRoles(accessAs('admin'), ROLES))).toEqual([
      'admin',
      'manager',
      'staff',
      'Auditor',
    ]);
  });

  it('offers only roles whose keys the actor holds', () => {
    expect(names(grantableRoles(accessAs('manager'), ROLES))).toEqual(['manager', 'staff']);
  });
});

describe('memberActions', () => {
  it('never offers actions on yourself', () => {
    expect(memberActions(accessAs('owner'), member(ME, 'staff'), ROLES)).toEqual({
      self: true,
      canChange: false,
      canRemove: false,
    });
  });

  it('lets only Owners change or remove Owners', () => {
    expect(memberActions(accessAs('owner'), member(OTHER, 'owner'), ROLES).canChange).toBe(true);
    expect(memberActions(accessAs('admin'), member(OTHER, 'owner'), ROLES)).toMatchObject({
      canChange: false,
      canRemove: false,
    });
    expect(memberActions(accessAs('admin'), member(OTHER, 'manager'), ROLES).canRemove).toBe(true);
  });

  it('needs platform.users.manage and the role list', () => {
    expect(memberActions(accessAs('manager'), member(OTHER, 'staff'), ROLES).canChange).toBe(false);
    expect(memberActions(accessAs('owner'), member(OTHER, 'staff'), null).canChange).toBe(false);
  });

  it("hides actions when the member's role isn't in the list (fails closed)", () => {
    const unknown = { ...member(OTHER, 'staff'), role: { id: id(99), systemKey: null, name: 'X' } };
    expect(memberActions(accessAs('owner'), unknown, ROLES).canChange).toBe(false);
  });
});

describe('canRevokeInvitation', () => {
  const invitation = (roleKey: string): Invitation => {
    const r = role(roleKey);
    return {
      id: id(80),
      email: 'i@example.test',
      role: { id: r.id, systemKey: r.systemKey, name: r.name },
      allLocations: true,
      locationIds: [],
      expiresAt: '2026-11-01T00:00:00.000Z',
      createdAt: '2026-10-25T00:00:00.000Z',
    };
  };

  it('needs platform.users.invite and a grantable role', () => {
    expect(canRevokeInvitation(accessAs('manager'), invitation('staff'), ROLES)).toBe(true);
    expect(canRevokeInvitation(accessAs('manager'), invitation('admin'), ROLES)).toBe(false);
    expect(canRevokeInvitation(accessAs('staff'), invitation('staff'), ROLES)).toBe(false);
  });
});

describe('custom-role editor', () => {
  it('offers only keys the actor holds', () => {
    const manager = accessAs('manager');
    expect(canOfferPermission(manager, 'platform.users.invite')).toBe(true);
    expect(canOfferPermission(manager, 'platform.users.manage')).toBe(false);
    for (const key of PERMISSION_KEYS)
      expect(canOfferPermission(accessAs('owner'), key)).toBe(true);
  });

  it('edits and deletes only custom roles within the actor keys, with platform.roles.manage', () => {
    expect(canEditCustomRole(accessAs('admin'), role('Auditor'))).toBe(true);
    expect(canEditCustomRole(accessAs('admin'), role('staff'))).toBe(false);
    expect(canEditCustomRole(accessAs('manager'), role('Auditor'))).toBe(false);
    const limited = usersAccessOf(
      sessionFixture({ activePermissions: ['platform.roles.manage', 'platform.roles.read'] }),
    );
    expect(canEditCustomRole(limited, role('Auditor'))).toBe(false);
  });

  it('groups keys by area in registry order, each area and key with an en and de label', () => {
    const groups = permissionGroups();
    expect(groups.map((g) => g.area)).toEqual([
      'platform.org',
      'platform.users',
      'platform.roles',
      'platform.settings',
      'platform.labels',
      'platform.audit',
      'platform.feedback',
      'catalog.products',
      'inventory.stock',
      'inventory.warehouses',
      'inventory.items',
      'inventory.recipes',
      'inventory.costs',
      'pos.tables',
      'pos.orders',
      'pos.bills',
      'pos.kitchen',
      'pos.bar',
      'reservations.bookings',
      'reservations.waitlist',
      'reservations.setup',
      'orders.orders',
      'orders.customers',
      'orders.picking',
      'orders.delivery',
    ]);
    expect(groups.flatMap((g) => g.keys)).toEqual([...PERMISSION_KEYS]);
    for (const locale of LOCALES) {
      for (const group of groups) {
        expect(areaLabel(group.area)).not.toBe('platform.rolesPage.otherArea');
        expect(dictionaries[locale][areaLabel(group.area)]).toBeTruthy();
        for (const key of group.keys)
          expect(dictionaries[locale][permissionLabel(key)]).toBeTruthy();
      }
    }
    expect(permissionGroups(['platform.audit.read', 'unknown.key']).map((g) => g.keys)).toEqual([
      ['platform.audit.read'],
    ]);
  });
});
