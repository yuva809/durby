import { dictionaries, isLabelKey } from '@durby/i18n';
import { FEATURES, PERMISSIONS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { activeNavItem, NAV_GROUPS, NAV_ITEMS, type NavItem, visibleNav } from './registry';
import { SETTINGS_TABS } from './settings-tabs';

const ids = (items: NavItem[]) => items.map((i) => i.id);
/** Main and module items: settings items depend on permissions, not on the plan. */
const moduleIds = (items: NavItem[]) => ids(items.filter((i) => i.group !== 'settings'));

describe('NAV_ITEMS', () => {
  it('uses registered features and permissions, and labels present in en and de', () => {
    for (const item of [...NAV_ITEMS, ...SETTINGS_TABS]) {
      if (item.feature) expect(Object.keys(FEATURES)).toContain(item.feature);
      if (item.permission) expect(Object.keys(PERMISSIONS)).toContain(item.permission);
      expect(isLabelKey(item.label)).toBe(true);
      expect(dictionaries.de[item.label]).toBeTruthy();
    }
    for (const group of NAV_GROUPS) {
      if (group.label) expect(dictionaries.de[group.label]).toBeTruthy();
    }
  });

  it('has unique ids and hrefs', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.id)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });
});

describe('visibleNav', () => {
  const items: NavItem[] = [
    { ...NAV_ITEMS[0]!, id: 'open' },
    { ...NAV_ITEMS[0]!, id: 'feature', feature: 'inventory' },
    { ...NAV_ITEMS[0]!, id: 'permission', permission: 'platform.audit.read' },
    { ...NAV_ITEMS[0]!, id: 'both', feature: 'billing', permission: 'platform.users.read' },
  ];

  it('shows only items without requirements to a session without features or permissions', () => {
    expect(ids(visibleNav(items, { activeFeatures: [], activePermissions: [] }))).toEqual(['open']);
  });

  it('needs the feature, the permission, or both', () => {
    expect(
      ids(visibleNav(items, { activeFeatures: ['inventory', 'billing'], activePermissions: [] })),
    ).toEqual(['open', 'feature']);
    expect(
      ids(
        visibleNav(items, {
          activeFeatures: [],
          activePermissions: ['platform.audit.read', 'platform.users.read'],
        }),
      ),
    ).toEqual(['open', 'permission']);
    expect(
      ids(
        visibleNav(items, {
          activeFeatures: ['billing'],
          activePermissions: ['platform.users.read'],
        }),
      ),
    ).toEqual(['open', 'both']);
  });

  // Inventory, Billing, POS and Reports aren't built yet: hidden whatever the plan.
  it('never shows planned modules', () => {
    const everything = {
      activeFeatures: Object.keys(FEATURES),
      activePermissions: Object.keys(PERMISSIONS),
    };
    expect(ids(visibleNav(NAV_ITEMS, everything))).toEqual([
      'home',
      'catalog',
      'service',
      'kitchen',
      'bar',
      'host',
      'tables',
      'staff',
      'settings',
      'audit',
    ]);
    expect(NAV_ITEMS.filter((i) => i.planned).map((i) => i.id)).toEqual([
      'inventory',
      'billing',
      'pos',
      'reports',
    ]);
  });

  it('shows Settings while any of its tabs is visible', () => {
    // The Company and Plan tabs need no permission: everyone has Settings.
    expect(ids(visibleNav(NAV_ITEMS, { activeFeatures: [], activePermissions: [] }))).toEqual([
      'home',
      'settings',
    ]);
    const parent: NavItem = {
      ...NAV_ITEMS[0]!,
      id: 'parent',
      children: [{ ...NAV_ITEMS[0]!, id: 'child', permission: 'platform.audit.read' }],
    };
    expect(ids(visibleNav([parent], { activeFeatures: [], activePermissions: [] }))).toEqual([]);
    expect(
      ids(visibleNav([parent], { activeFeatures: [], activePermissions: ['platform.audit.read'] })),
    ).toEqual(['parent']);
  });
});

describe('table service items', () => {
  it('shows Products, Service and Tables with their feature, each behind its read key', () => {
    const features = ['catalog', 'pos'];
    expect(
      moduleIds(visibleNav(NAV_ITEMS, { activeFeatures: features, activePermissions: [] })),
    ).toEqual(['home']);
    expect(
      moduleIds(
        visibleNav(NAV_ITEMS, {
          activeFeatures: features,
          activePermissions: ['catalog.products.read', 'pos.orders.read', 'pos.tables.read'],
        }),
      ),
    ).toEqual(['home', 'catalog', 'service', 'tables']);
  });
});

describe('activeNavItem', () => {
  it.each([
    ['/', 'home'],
    ['/inventory', 'inventory'],
    ['/inventory/items/1', 'inventory'],
    ['/inventoryx', undefined],
    ['/pos', 'pos'],
    ['/settings', 'settings'],
    ['/settings/members', 'settings'],
    ['/audit', 'audit'],
    ['/service', 'service'],
    ['/service/x', 'service'],
    ['/tables', 'tables'],
    ['/host', 'host'],
    ['/unknown', undefined],
  ])('%s → %s', (path, id) => {
    expect(activeNavItem(NAV_ITEMS, path)?.id).toBe(id);
  });
});
