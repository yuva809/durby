import type { LabelKey } from '@durby/i18n';
import type { NavLayout } from '@durby/shared';
import {
  Archive,
  Building2,
  Download,
  Heart,
  LayoutGrid,
  MapPin,
  Package,
  Truck,
} from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, type NavGroup, type NavItem } from './registry';

export interface NavLayoutDefinition {
  groups: readonly { id: NavGroup; label: LabelKey | null }[];
  items: readonly NavItem[];
}

const item = (id: string) => {
  const found = NAV_ITEMS.find((i) => i.id === id);
  if (!found) throw new Error(`nav item ${id} missing`);
  return found;
};

const inventory = item('inventory');

/**
 * The operations menu (ADR 0044): a distribution business's sidebar in three groups. Same items,
 * features and permissions as Durby's menu where a page exists; items marked `planned` show once
 * their module ships. Product Category is its own item here, so it leaves the Inventory submenu.
 */
const OPERATIONS: NavLayoutDefinition = {
  groups: [
    { id: 'main', label: null },
    { id: 'operations', label: 'platform.nav.groups.operations' },
    { id: 'administration', label: 'platform.nav.groups.administration' },
    { id: 'tools', label: 'platform.nav.groups.tools' },
  ],
  items: [
    item('home'),
    {
      ...inventory,
      icon: Archive,
      group: 'operations',
      children: inventory.children?.filter((page) => page.id !== 'inventory-categories'),
    },
    {
      id: 'categories',
      href: '/catalog/categories',
      label: 'platform.nav.productCategories',
      icon: LayoutGrid,
      group: 'operations',
      feature: 'catalog',
      permission: 'catalog.products.read',
    },
    {
      id: 'orders',
      href: '/orders',
      label: 'platform.nav.orderHistory',
      icon: Package,
      group: 'operations',
      feature: 'orders',
      permission: 'orders.orders.read',
    },
    {
      id: 'picking',
      href: '/picking',
      label: 'platform.nav.picking',
      icon: Truck,
      group: 'operations',
      feature: 'inventory',
      planned: true,
    },
    {
      // Settings → Locations as its own page.
      id: 'branches',
      href: '/branches',
      label: 'platform.nav.branches',
      icon: Building2,
      group: 'operations',
      permission: 'platform.settings.read',
    },
    {
      id: 'deliveries',
      href: '/deliveries',
      label: 'platform.nav.deliveries',
      icon: MapPin,
      group: 'operations',
      feature: 'inventory',
      planned: true,
    },
    { ...item('audit'), group: 'administration' },
    { ...item('staff'), group: 'administration' },
    { ...item('settings'), group: 'administration' },
    {
      id: 'import',
      href: '/import',
      label: 'platform.nav.importData',
      icon: Download,
      group: 'tools',
      planned: true,
    },
    {
      id: 'feedback',
      href: '/feedback',
      label: 'platform.nav.feedback',
      icon: Heart,
      group: 'tools',
      planned: true,
    },
  ],
};

const DEFAULT: NavLayoutDefinition = { groups: NAV_GROUPS, items: NAV_ITEMS };

/** The sidebar for a partner theme's layout (ADR 0044); unknown or absent → Durby's menu. */
export function navLayout(layout: NavLayout | undefined): NavLayoutDefinition {
  return layout === 'operations' ? OPERATIONS : DEFAULT;
}

/** For tests: every layout. */
export const NAV_LAYOUT_DEFINITIONS: Readonly<Record<NavLayout, NavLayoutDefinition>> = {
  default: DEFAULT,
  operations: OPERATIONS,
};
