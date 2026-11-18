import { describe, expect, it } from 'vitest';
import { dictionaries, LOCALES } from '@durby/i18n';
import {
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  systemRolePermissions,
  type TeamMember,
} from '@durby/shared';
import type { UsersAccess } from '../users/access';
import {
  blockedByView,
  canToggle,
  generatePassword,
  overridesOf,
  viewKeyFor,
  permissionMatrix,
  selectedOf,
  teamRowActions,
  tickMany,
  tickOne,
  whatsappUrl,
} from './matrix';

const access = (keys: string[], systemRole: UsersAccess['actor']['systemRole'] = 'manager') =>
  ({
    actor: { userId: 'me', systemRole, permissions: new Set(keys) },
    canReadUsers: true,
    canInvite: true,
    canEditUsers: keys.includes('platform.users.edit'),
    canRemoveUsers: keys.includes('platform.users.delete'),
    canReadRoles: true,
    canCreateRoles: false,
    canEditRoles: false,
    canDeleteRoles: false,
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
  warehouseIds: [],
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

const ALL_FEATURES = ['catalog', 'inventory', 'pos', 'reservations', 'orders'];

describe('permissionMatrix (ADR 0050)', () => {
  it('shows platform keys always and a module only when its feature is on', () => {
    const { sections, hiddenModules } = permissionMatrix(['catalog']);
    expect(sections.map((s) => s.module)).toEqual(['platform', 'catalog']);
    expect(hiddenModules).toEqual([
      'platform.features.inventory.name',
      'platform.features.pos.name',
      'platform.features.reservations.name',
      'platform.features.orders.name',
    ]);
  });

  it('puts every key in exactly one cell, in registry order', () => {
    const { sections } = permissionMatrix(ALL_FEATURES);
    expect(sections.map((s) => s.module)).toEqual([
      'platform',
      'catalog',
      'inventory',
      'pos',
      'reservations',
      'orders',
    ]);
    const fromCells = sections.flatMap((s) =>
      s.rows.flatMap((r) => Object.values(r.cells).flatMap((c) => (c ? [c.key] : []))),
    );
    expect([...fromCells].sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(sections.flatMap((s) => s.keys)).toEqual([...PERMISSION_KEYS]);
  });

  it('places job verbs in their own rows (Picking → Edit, POS orders across all four)', () => {
    const rows = permissionMatrix(ALL_FEATURES).sections.flatMap((s) => s.rows);
    const row = (id: string) => rows.find((r) => r.row === id);
    expect(row('orders.picking')?.cells).toEqual({
      read: null,
      create: null,
      edit: { key: 'orders.picking.use', note: null },
      delete: null,
    });
    expect(row('pos.orders')?.cells).toEqual({
      read: { key: 'pos.orders.read', note: null },
      create: { key: 'pos.orders.take', note: null },
      edit: { key: 'pos.orders.close', note: null },
      delete: { key: 'pos.orders.void', note: null },
    });
    // ADR 0051: the broad keys are split, so every box means what its column says and none carries a note.
    expect(row('platform.users')?.cells).toEqual({
      read: { key: 'platform.users.read', note: null },
      create: { key: 'platform.users.invite', note: null },
      edit: { key: 'platform.users.edit', note: null },
      delete: { key: 'platform.users.delete', note: null },
    });
    expect(row('platform.roles')?.cells.create?.key).toBe('platform.roles.create');
    expect(row('platform.org')?.cells.read?.key).toBe('platform.org.read');
    expect(row('orders.salesOrders')?.cells.delete?.key).toBe('orders.orders.delete');
    expect(row('orders.customers')?.cells.delete?.key).toBe('orders.customers.delete');
    const notes = rows.flatMap((r) =>
      Object.values(r.cells).flatMap((c) => (c?.note ? [c.key] : [])),
    );
    expect(notes).toEqual([]);
  });

  it('has an en and de label for every section, row and note', () => {
    const { sections } = permissionMatrix(ALL_FEATURES);
    const labels = sections.flatMap((s) => [
      s.label,
      ...s.rows.flatMap((r) => [
        r.label,
        ...Object.values(r.cells).flatMap((c) => (c?.note ? [c.note] : [])),
      ]),
    ]);
    expect(labels).not.toContain('platform.rolesPage.otherArea');
    for (const locale of LOCALES) {
      for (const label of labels) expect(dictionaries[locale][label], label).toBeTruthy();
    }
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

  // ADR 0050 changes only the layout: what is saved for a role stays exactly the same.
  it.each(SYSTEM_ROLES)('saves no changes for the %s role defaults', (systemRole) => {
    const keys = systemRolePermissions(systemRole);
    expect(JSON.stringify(overridesOf(keys, selectedOf(keys, { grants: [], denies: [] })))).toBe(
      '{"grants":[],"denies":[]}',
    );
  });

  it('saves the same payload as before the matrix layout change', () => {
    const manager = systemRolePermissions('manager');
    const selected = new Set(manager);
    selected.delete('inventory.stock.adjust');
    selected.delete('orders.picking.use');
    selected.add('catalog.products.edit');
    selected.add('platform.users.edit');
    expect(JSON.stringify(overridesOf(manager, selected))).toBe(
      '{"grants":["platform.users.edit","catalog.products.edit"],"denies":["inventory.stock.adjust","orders.picking.use"]}',
    );
  });
});

describe('teamRowActions and canToggle', () => {
  it('never offers actions on yourself or without platform.users.edit or .delete', () => {
    expect(
      teamRowActions(
        access(['platform.users.edit', 'platform.users.delete', 'pos.orders.read']),
        member({ userId: 'me' }),
      ),
    ).toEqual({ self: true, canEdit: false, canRemove: false });
    expect(teamRowActions(access(['pos.orders.read']), member()).canEdit).toBe(false);
  });

  it('compares the member by their effective keys', () => {
    const manager = access(['platform.users.edit', 'platform.users.delete', 'pos.orders.read']);
    expect(teamRowActions(manager, member()).canEdit).toBe(true);
    expect(
      teamRowActions(manager, member({ permissions: ['pos.orders.read', 'catalog.products.edit'] }))
        .canEdit,
    ).toBe(false);
  });

  // ADR 0051: editing and removing are separate boxes.
  it('offers edit with platform.users.edit and remove with platform.users.delete, each on its own', () => {
    expect(teamRowActions(access(['platform.users.edit', 'pos.orders.read']), member())).toEqual({
      self: false,
      canEdit: true,
      canRemove: false,
    });
    expect(teamRowActions(access(['platform.users.delete', 'pos.orders.read']), member())).toEqual({
      self: false,
      canEdit: false,
      canRemove: true,
    });
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

describe('teamRowActions and canToggle', () => {
  it('never offers actions on yourself or without platform.users.edit or .delete', () => {
    expect(
      teamRowActions(
        access(['platform.users.edit', 'platform.users.delete', 'pos.orders.read']),
        member({ userId: 'me' }),
      ),
    ).toEqual({ self: true, canEdit: false, canRemove: false });
    expect(teamRowActions(access(['pos.orders.read']), member()).canEdit).toBe(false);
  });

  it('compares the member by their effective keys', () => {
    const manager = access(['platform.users.edit', 'platform.users.delete', 'pos.orders.read']);
    expect(teamRowActions(manager, member()).canEdit).toBe(true);
    expect(
      teamRowActions(manager, member({ permissions: ['pos.orders.read', 'catalog.products.edit'] }))
        .canEdit,
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

describe('Grant View first', () => {
  const all = () => true;
  const SALES = [
    'orders.orders.read',
    'orders.orders.create',
    'orders.orders.edit',
    'orders.orders.delete',
  ];

  it('gates the actions of rows that have a View box, and nothing else', () => {
    expect(viewKeyFor('orders.orders.create')).toBe('orders.orders.read');
    expect(viewKeyFor('platform.users.delete')).toBe('platform.users.read');
    expect(viewKeyFor('orders.orders.read')).toBeNull();
    // Rows without a View box: Picking, Deliveries, Warehouses.
    expect(viewKeyFor('orders.picking.use')).toBeNull();
    expect(viewKeyFor('inventory.stock.receive')).toBeNull();
    expect(viewKeyFor('inventory.warehouses.create')).toBeNull();
  });

  it('blocks an unticked action until its View is ticked, never one already ticked', () => {
    expect(blockedByView(new Set(), 'orders.orders.create')).toBe(true);
    expect(blockedByView(new Set(['orders.orders.read']), 'orders.orders.create')).toBe(false);
    // Saved before the rule: ticked without View stays untickable.
    expect(blockedByView(new Set(['orders.orders.create']), 'orders.orders.create')).toBe(false);
    expect(blockedByView(new Set(), 'orders.picking.use')).toBe(false);
  });

  it('ticks an action only with its View, and unticking View clears the row (not locked boxes)', () => {
    expect([...tickOne(new Set(), 'orders.orders.create', true, all)]).toEqual([]);
    const full = new Set(SALES);
    expect([...tickOne(full, 'orders.orders.read', false, all)]).toEqual([]);
    const lockedDelete = (key: string) => key !== 'orders.orders.delete';
    expect([...tickOne(full, 'orders.orders.read', false, lockedDelete)]).toEqual([
      'orders.orders.delete',
    ]);
    // Unticking an action leaves View alone.
    expect([...tickOne(full, 'orders.orders.edit', false, all)].sort()).toEqual(
      ['orders.orders.create', 'orders.orders.delete', 'orders.orders.read'].sort(),
    );
  });

  it('ticks many only where View ends up ticked, and clears actions with their View', () => {
    expect([...tickMany(new Set(), SALES, true, all)].sort()).toEqual([...SALES].sort());
    // View locked and unticked: its actions are skipped; rows without View still tick.
    const viewLocked = (key: string) => key !== 'orders.orders.read';
    expect([...tickMany(new Set(), [...SALES, 'orders.picking.use'], true, viewLocked)]).toEqual([
      'orders.picking.use',
    ]);
    // View locked but already ticked: the actions tick.
    expect([...tickMany(new Set(['orders.orders.read']), SALES, true, viewLocked)].sort()).toEqual(
      [...SALES].sort(),
    );
    expect([...tickMany(new Set(SALES), ['orders.orders.read'], false, all)]).toEqual([]);
  });

  it('leaves data saved before the rule as it is until someone changes it', () => {
    const saved = new Set(['orders.orders.create']);
    expect([...tickOne(saved, 'orders.picking.use', true, all)].sort()).toEqual([
      'orders.orders.create',
      'orders.picking.use',
    ]);
  });
});
