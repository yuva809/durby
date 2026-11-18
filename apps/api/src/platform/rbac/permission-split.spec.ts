import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_PERMISSION_ALIASES,
  PERMISSIONS,
  SYSTEM_ROLES,
  type SystemRole,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { resolveAccess, storedRoleKeys } from './access';
import { canManageMember, type RoleView } from './granting';
import {
  addedKeys,
  addedOverrides,
  ORG_READ,
  PERMISSION_SPLIT,
  splitEffect,
} from './permission-split';

const MIGRATION = join(
  __dirname,
  '../../../prisma/migrations/20261118150000_split_broad_permission_keys/migration.sql',
);

type Override = { permissionKey: string; effect: 'grant' | 'deny' };
const grant = (permissionKey: string): Override => ({ permissionKey, effect: 'grant' });
const deny = (permissionKey: string): Override => ({ permissionKey, effect: 'deny' });

/** Stored keys of custom roles as they exist before ADR 0051. */
const CUSTOM_ROLES: readonly (readonly string[])[] = [
  [],
  ['platform.users.read', 'platform.users.manage'],
  ['platform.roles.read', 'platform.roles.manage', 'platform.users.invite'],
  ['orders.orders.read', 'orders.orders.edit', 'orders.customers.edit'],
  [
    'platform.users.manage',
    'platform.roles.manage',
    'orders.orders.edit',
    'catalog.products.manage',
  ],
];

/** Per-member overrides as they exist before ADR 0051, mixed grants and denies. */
const OVERRIDES: readonly (readonly Override[])[] = [
  [],
  [grant('platform.users.manage')],
  [deny('platform.users.manage')],
  [grant('platform.roles.manage'), deny('orders.orders.edit')],
  [deny('orders.customers.edit'), grant('orders.orders.edit')],
  [deny('platform.roles.manage'), deny('platform.users.manage'), grant('orders.customers.edit')],
];

describe('ADR 0051 split', () => {
  it('uses the same table in code and in the migration', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const pairs = [...sql.matchAll(/\('([a-z.]+)', '([a-z.]+)'\)/g)].map(([, from, to]) => [
      from,
      to,
    ]);
    const fromCode = Object.entries(PERMISSION_SPLIT).flatMap(([from, to]) =>
      to.map((key) => [from, key]),
    );
    expect(pairs).toEqual(fromCode);
    // Every new key is registered, every split key is either still registered or an alias.
    for (const [from, to] of fromCode) {
      expect(Object.hasOwn(PERMISSIONS, to!)).toBe(true);
      expect(
        Object.hasOwn(PERMISSIONS, from!) || Object.hasOwn(LEGACY_PERMISSION_ALIASES, from!),
      ).toBe(true);
    }
  });

  it.each(SYSTEM_ROLES)(
    'keeps the effective permissions of a %s member, whatever their overrides',
    (role) => {
      for (const overrides of OVERRIDES) {
        const { before, after } = splitEffect(PERMISSIONS, role, [], overrides);
        expect(after, JSON.stringify(overrides)).toEqual(before);
      }
    },
  );

  it('keeps the effective permissions of custom roles and their members', () => {
    for (const keys of CUSTOM_ROLES) {
      for (const overrides of OVERRIDES) {
        const { before, after } = splitEffect(PERMISSIONS, null, keys, overrides);
        expect(after, `${keys.join(',')} / ${JSON.stringify(overrides)}`).toEqual(before);
      }
    }
  });

  it('adds nothing the second time (idempotent)', () => {
    for (const keys of CUSTOM_ROLES) {
      const once = [...keys, ...addedKeys(keys, true)];
      expect(addedKeys(once, true)).toEqual([]);
    }
    for (const overrides of OVERRIDES) {
      const once = [...overrides, ...addedOverrides(overrides)];
      expect(addedOverrides(once)).toEqual([]);
    }
  });

  it('copies the effect onto each new key and gives custom roles the organization view', () => {
    expect(addedOverrides([deny('platform.users.manage')])).toEqual([
      deny('platform.users.edit'),
      deny('platform.users.delete'),
    ]);
    expect(addedKeys(['orders.orders.edit'], true)).toEqual(['orders.orders.delete', ORG_READ]);
    expect(addedKeys(['orders.orders.edit'])).toEqual(['orders.orders.delete']);
  });
});

/**
 * The subset rule ("you can only manage people whose permissions are within yours", ADR 0007 §6, ADR 0023 §2) for a
 * member who still holds the legacy users.manage / roles.manage keys: exactly the same verdicts as with the keys they
 * stand for, and as before the split.
 */
describe('subset rule with the legacy aliases (ADR 0051)', () => {
  const base = ['platform.users.read', 'platform.roles.read', 'platform.settings.read'];
  const actorWith = (stored: readonly string[]) => ({
    userId: 'actor',
    access: resolveAccess(PERMISSIONS, {
      id: 'm',
      allLocations: true,
      role: {
        id: 'r',
        systemKey: null,
        permissions: stored.map((permissionKey) => ({ permissionKey })),
      },
      locations: [],
    }),
  });
  const view = (systemKey: SystemRole | null, stored: readonly string[] = []): RoleView => ({
    systemKey,
    keys: storedRoleKeys(PERMISSIONS, systemKey, stored),
  });
  const targets: Record<string, RoleView> = {
    staff: view('staff'),
    manager: view('manager'),
    admin: view('admin'),
    owner: view('owner'),
    legacyUserManager: view(null, [...base, 'platform.users.manage']),
    splitUserManager: view(null, [...base, 'platform.users.edit', 'platform.users.delete']),
    legacyRoleManager: view(null, [...base, 'platform.roles.manage']),
    editOnly: view(null, [...base, 'platform.users.edit']),
    readers: view(null, base),
  };
  const verdicts = (stored: readonly string[]) =>
    Object.fromEntries(
      Object.entries(targets).map(([name, role]) => [
        name,
        canManageMember(actorWith(stored), { userId: 'target', role }),
      ]),
    );

  it('gives a legacy users.manage holder the same verdicts as the users.edit + users.delete holder', () => {
    const legacy = verdicts([...base, 'platform.users.manage']);
    const split = verdicts([...base, 'platform.users.edit', 'platform.users.delete']);
    expect(legacy).toEqual(split);
    // As before the split: within their own keys yes, anyone holding more no.
    expect(legacy).toEqual({
      staff: 'not_grantable',
      manager: 'not_grantable',
      admin: 'not_grantable',
      owner: 'not_grantable',
      legacyUserManager: 'ok',
      splitUserManager: 'ok',
      legacyRoleManager: 'not_grantable',
      editOnly: 'ok',
      readers: 'ok',
    });
  });

  it('gives a legacy roles.manage holder the same verdicts as the roles.create/edit/delete holder', () => {
    const legacy = verdicts([...base, 'platform.users.manage', 'platform.roles.manage']);
    const split = verdicts([
      ...base,
      'platform.users.edit',
      'platform.users.delete',
      'platform.roles.create',
      'platform.roles.edit',
      'platform.roles.delete',
    ]);
    expect(legacy).toEqual(split);
    expect(legacy.legacyRoleManager).toBe('ok');
  });

  it('does not let users.edit alone manage someone holding the legacy users.manage', () => {
    expect(verdicts([...base, 'platform.users.edit']).legacyUserManager).toBe('not_grantable');
  });
});
