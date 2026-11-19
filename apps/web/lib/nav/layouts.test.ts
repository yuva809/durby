import { dictionaries, isLabelKey } from '@durby/i18n';
import {
  FEATURES,
  NAV_LAYOUTS,
  PERMISSIONS,
  type SystemRole,
  systemRolePermissions,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { BRANCH_NAV_LAYOUT, isBranchView, NAV_LAYOUT_DEFINITIONS, navLayout } from './layouts';
import { activeNavItem, NAV_ITEMS, type NavItem, visibleNav } from './registry';

const ids = (items: NavItem[]) => items.map((i) => i.id);
const flat = (items: readonly NavItem[]): NavItem[] =>
  items.flatMap((i) => [i, ...flat(i.children ?? [])]);

// The inventory plan's owner (ADR 0040): inventory and catalog, every permission.
const owner = {
  activeFeatures: ['inventory', 'catalog', 'orders'],
  activePermissions: Object.keys(PERMISSIONS),
};

describe('nav layouts (ADR 0044)', () => {
  it('has a definition for every layout', () => {
    expect(Object.keys(NAV_LAYOUT_DEFINITIONS).sort()).toEqual([...NAV_LAYOUTS].sort());
  });

  it.each([...NAV_LAYOUTS, 'branch'] as const)(
    '%s: registered keys, labels in en and de, unique ids and hrefs',
    (key) => {
      const { groups, items } = key === 'branch' ? BRANCH_NAV_LAYOUT : NAV_LAYOUT_DEFINITIONS[key];
      for (const item of flat(items)) {
        if (item.feature) expect(Object.keys(FEATURES)).toContain(item.feature);
        if (item.permission) expect(Object.keys(PERMISSIONS)).toContain(item.permission);
        expect(isLabelKey(item.label)).toBe(true);
        expect(dictionaries.de[item.label]).toBeTruthy();
      }
      // Pages under an item (submenus, settings tabs) are shown with their parent.
      for (const item of items) expect(groups.map((g) => g.id)).toContain(item.group);
      for (const group of groups)
        if (group.label) expect(dictionaries.de[group.label]).toBeTruthy();
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
      expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    },
  );

  it('gives unknown and absent layouts Durby menu', () => {
    expect(navLayout(undefined).items).toBe(NAV_ITEMS);
    expect(navLayout('default').items).toBe(NAV_ITEMS);
  });

  it('shows the operations menu in its groups, planned modules hidden', () => {
    const { groups, items } = navLayout('operations');
    const visible = visibleNav(items, owner);
    const byGroup = Object.fromEntries(
      groups.map((g) => [g.id, ids(visible.filter((i) => i.group === g.id))]),
    );
    expect(byGroup).toEqual({
      main: ['home'],
      operations: [
        'inventory',
        'categories',
        'order-history',
        'orders',
        'picking',
        'branches',
        'deliveries',
        'my-deliveries',
      ],
      administration: ['audit', 'staff', 'settings'],
      tools: ['import', 'feedback'],
    });
    expect(ids(items.filter((i) => i.planned === true))).toEqual([]);
  });

  it('lists Product Category on its own, not again under Inventory', () => {
    const inventory = navLayout('operations').items.find((i) => i.id === 'inventory');
    expect(ids(visibleNav(inventory?.children ?? [], owner))).not.toContain('inventory-categories');
    expect(activeNavItem(navLayout('operations').items, '/catalog/categories')?.id).toBe(
      'categories',
    );
  });

  it('hides items the role lacks: a manager without settings sees no Branches', () => {
    const visible = visibleNav(navLayout('operations').items, {
      activeFeatures: ['inventory', 'catalog'],
      activePermissions: ['inventory.stock.read', 'catalog.products.read'],
    });
    expect(ids(visible)).toEqual(['home', 'inventory', 'categories', 'settings']);
  });
});

describe('the operations menu per branch role (ADR 0045, 0059)', () => {
  const access = (role: SystemRole) => ({
    activeFeatures: ['inventory', 'catalog', 'orders'],
    activePermissions: [...systemRolePermissions(role)],
  });
  // As the sidebar shows it: the layout for the person.
  const menu = (role: SystemRole) =>
    ids(visibleNav(navLayout('operations', access(role)).items, access(role)));

  it('gives each role its part of the flow', () => {
    // A branch has its own menu: Inventory (with the request cart), Order History, Delivery Tracking, Feedback.
    expect(menu('branch')).toEqual(['inventory', 'order-history', 'branch-deliveries', 'feedback']);
    expect(menu('warehouse')).toEqual([
      'home',
      'inventory',
      'order-history',
      'orders',
      'picking',
      'branches',
      'deliveries',
      'settings',
      // Booking goods in includes importing opening stock.
      'import',
      'feedback',
    ]);
    // No Overview for a driver (item 14).
    expect(menu('driver')).toEqual(['my-deliveries', 'settings', 'feedback']);
    // The new-request form belongs to Stock Requests: one menu item (ADR 0052); for a branch, to its Order History.
    expect(activeNavItem(navLayout('operations').items, '/requests/new')?.id).toBe('order-history');
    expect(activeNavItem(BRANCH_NAV_LAYOUT.items, '/requests/new')?.id).toBe('order-history');
  });

  it('knows a branch: asks for goods, neither approves nor handles sales orders', () => {
    expect(isBranchView(access('branch'))).toBe(true);
    for (const role of ['owner', 'admin', 'manager', 'warehouse', 'driver'] as const) {
      expect(isBranchView(access(role))).toBe(false);
    }
    // Only the operations layout has a branch menu.
    expect(navLayout('default', access('branch')).items).toBe(NAV_ITEMS);
    expect(navLayout('operations', access('branch'))).toBe(BRANCH_NAV_LAYOUT);
  });
});
