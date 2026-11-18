import { describe, expect, it } from 'vitest';
import type { TeamMember } from '@durby/shared';
import type { UsersAccess } from '../users/access';
import {
  canToggle,
  crudRow,
  generatePassword,
  moduleOf,
  overridesOf,
  selectedOf,
  teamRowActions,
  visiblePermissions,
  whatsappUrl,
} from './matrix';

const access = (keys: string[], systemRole: UsersAccess['actor']['systemRole'] = 'manager') =>
  ({
    actor: { userId: 'me', systemRole, permissions: new Set(keys) },
    canReadUsers: true,
    canInvite: true,
    canManageUsers: keys.includes('platform.users.manage'),
    canReadRoles: true,
    canManageRoles: false,
  }) satisfies UsersAccess;

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  membershipId: '0190a000-0000-7000-8000-000000000501',
  userId: 'someone',
  name: 'Ravi',
  email: 'ravi@example.test',
  phone: null,
  role: { id: '0190a000-0000-7000-8000-000000000601', systemKey: 'waiter', name: null },
  allLocations: true,
  locationIds: [],
  grants: [],
  denies: [],
  permissions: ['pos.orders.read'],
  status: 'active',
  lastActiveAt: null,
  joinedAt: '2026-11-03T10:00:00.000Z',
  passwordChangePending: false,
  passwordSettable: false,
  ...over,
});

describe('visiblePermissions', () => {
  it('shows platform keys always and a module only when its feature is on', () => {
    const { groups, hiddenModules } = visiblePermissions(['catalog']);
    const modules = new Set(groups.flatMap((g) => g.keys.map(moduleOf)));
    expect(modules).toEqual(new Set(['platform', 'catalog']));
    expect(hiddenModules).toEqual([
      'platform.features.inventory.name',
      'platform.features.pos.name',
      'platform.features.reservations.name',
      'platform.features.orders.name',
    ]);
  });
});

describe('selectedOf and overridesOf', () => {
  const role = new Set(['pos.orders.read', 'pos.bills.print']);

  it('ticks the role keys with the grants added and the denies removed', () => {
    const selected = selectedOf(role, {
      grants: ['catalog.products.edit'],
      denies: ['pos.bills.print'],
    });
    expect([...selected].sort()).toEqual(['catalog.products.edit', 'pos.orders.read']);
  });

  it('turns ticks back into the changes against the role, in registry order', () => {
    expect(overridesOf(role, new Set(['pos.orders.read', 'catalog.products.edit']))).toEqual({
      grants: ['catalog.products.edit'],
      denies: ['pos.bills.print'],
    });
    expect(overridesOf(role, role)).toEqual({ grants: [], denies: [] });
  });
});

describe('teamRowActions and canToggle', () => {
  it('never offers actions on yourself or without platform.users.manage', () => {
    expect(
      teamRowActions(
        access(['platform.users.manage', 'pos.orders.read']),
        member({ userId: 'me' }),
      ),
    ).toEqual({ self: true, canManage: false });
    expect(teamRowActions(access(['pos.orders.read']), member()).canManage).toBe(false);
  });

  it('compares the member by their effective keys', () => {
    const manager = access(['platform.users.manage', 'pos.orders.read']);
    expect(teamRowActions(manager, member()).canManage).toBe(true);
    expect(
      teamRowActions(manager, member({ permissions: ['pos.orders.read', 'catalog.products.edit'] }))
        .canManage,
    ).toBe(false);
  });

  it('lets you tick only keys you hold', () => {
    expect(canToggle(access(['pos.orders.read']), 'pos.orders.read')).toBe(true);
    expect(canToggle(access(['pos.orders.read']), 'catalog.products.edit')).toBe(false);
  });
});

describe('generatePassword and whatsappUrl', () => {
  it('makes an unambiguous password of the given length', () => {
    const password = generatePassword(16, (bytes) => bytes.map((_, i) => i * 7));
    expect(password).toHaveLength(16);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it('puts the text into a wa.me link', () => {
    expect(whatsappUrl('Join us: https://x.test/a#token=1')).toBe(
      'https://wa.me/?text=Join%20us%3A%20https%3A%2F%2Fx.test%2Fa%23token%3D1',
    );
  });
});

describe('crudRow (ADR 0037)', () => {
  it("puts an entity's keys in its View, Create, Edit and Delete cells", () => {
    expect(
      crudRow([
        'catalog.products.delete',
        'catalog.products.read',
        'catalog.products.edit',
        'catalog.products.create',
      ]),
    ).toEqual({
      cells: {
        read: 'catalog.products.read',
        create: 'catalog.products.create',
        edit: 'catalog.products.edit',
        delete: 'catalog.products.delete',
      },
      extra: [],
    });
  });

  it('leaves a cell empty when the entity has no such key, and keeps other keys', () => {
    const row = crudRow([
      'reservations.bookings.create',
      'reservations.bookings.edit',
      'reservations.bookings.arrive',
    ]);
    expect(row?.cells).toEqual({
      read: null,
      create: 'reservations.bookings.create',
      edit: 'reservations.bookings.edit',
      delete: null,
    });
    expect(row?.extra).toEqual(['reservations.bookings.arrive']);
  });

  it('is null for a group without create, edit or delete keys (shown as a list)', () => {
    expect(crudRow(['pos.orders.read', 'pos.orders.take'])).toBeNull();
  });
});
