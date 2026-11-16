import { dictionaries, isLabelKey } from '@durby/i18n';
import { FEATURES, NAV_LAYOUTS, PERMISSIONS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { NAV_LAYOUT_DEFINITIONS, navLayout } from './layouts';
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

  it.each(NAV_LAYOUTS)('%s: registered keys, labels in en and de, unique ids and hrefs', (key) => {
    const { groups, items } = NAV_LAYOUT_DEFINITIONS[key];
    for (const item of flat(items)) {
      if (item.feature) expect(Object.keys(FEATURES)).toContain(item.feature);
      if (item.permission) expect(Object.keys(PERMISSIONS)).toContain(item.permission);
      expect(isLabelKey(item.label)).toBe(true);
      expect(dictionaries.de[item.label]).toBeTruthy();
    }
    // Pages under an item (submenus, settings tabs) are shown with their parent.
    for (const item of items) expect(groups.map((g) => g.id)).toContain(item.group);
    for (const group of groups) if (group.label) expect(dictionaries.de[group.label]).toBeTruthy();
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
  });

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
      operations: ['inventory', 'categories', 'orders', 'picking', 'branches', 'deliveries'],
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
