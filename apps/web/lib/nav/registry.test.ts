import { dictionaries, isLabelKey } from '@durby/i18n';
import { FEATURES, PERMISSIONS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { activeNavItem, NAV_GROUPS, NAV_ITEMS, type NavItem, visibleNav } from './registry';

const ids = (items: NavItem[]) => items.map((i) => i.id);

describe('NAV_ITEMS', () => {
  it('uses registered features and permissions, and labels present in en and de', () => {
    for (const item of NAV_ITEMS) {
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

  // The two-domain demo: the inventory plan vs the full plan (docs/platform/entitlements.md).
  it('shows the modules of the plan', () => {
    const inventoryPlan = ['inventory', 'inventory.counts', 'inventory.purchasing', 'reports'];
    expect(
      ids(visibleNav(NAV_ITEMS, { activeFeatures: inventoryPlan, activePermissions: [] })),
    ).toEqual(['home', 'inventory', 'reports']);
    expect(
      ids(
        visibleNav(NAV_ITEMS, {
          activeFeatures: ['inventory', 'billing', 'pos', 'reports'],
          activePermissions: [],
        }),
      ),
    ).toEqual(['home', 'inventory', 'billing', 'pos', 'reports']);
  });
});

describe('activeNavItem', () => {
  it.each([
    ['/', 'home'],
    ['/inventory', 'inventory'],
    ['/inventory/items/1', 'inventory'],
    ['/inventoryx', undefined],
    ['/unknown', undefined],
  ])('%s → %s', (path, id) => {
    expect(activeNavItem(NAV_ITEMS, path)?.id).toBe(id);
  });
});
