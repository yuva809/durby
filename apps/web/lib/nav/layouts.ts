import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, NavLayout, PermissionKey } from '@durby/shared';
import {
  Archive,
  Building2,
  ClipboardList,
  Download,
  Heart,
  LayoutGrid,
  MapPin,
  Package,
  Truck,
} from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, type NavAccess, type NavGroup, type NavItem } from './registry';

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

const FEEDBACK: NavItem = {
  id: 'feedback',
  href: '/feedback',
  label: 'platform.nav.feedback',
  icon: Heart,
  group: 'tools',
  permission: 'platform.feedback.send',
};

/**
 * The operations menu (ADR 0044): a distribution business's sidebar in three groups. Same items,
 * features and permissions as Durby's menu where a page exists; items marked `planned` show once
 * their module ships. Inventory is one item without a submenu (ADR 0048); Product Category is its own item.
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
    // One item, no submenu (ADR 0048): the page opens on category tiles; its More menu has the other pages.
    { ...inventory, icon: Archive, group: 'operations', children: undefined },
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
      // Branch requests by stage; owners and admins approve here. A branch asks the main warehouse for goods from
      // its "Request stock" button (ADR 0045, 0052).
      id: 'stock-requests',
      href: '/requests',
      label: 'platform.nav.stockRequests',
      icon: ClipboardList,
      group: 'operations',
      feature: 'orders',
      permission: 'orders.requests.read',
    },
    {
      id: 'picking',
      href: '/picking',
      label: 'platform.nav.picking',
      icon: Truck,
      group: 'operations',
      feature: 'orders',
      permission: 'orders.picking.use',
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
      feature: 'orders',
      // The overview of every delivery: those who assign drivers (owner, admin, manager, warehouse), not drivers.
      permission: 'orders.delivery.assign',
    },
    {
      // A driver's own deliveries (ADR 0045).
      id: 'my-deliveries',
      href: '/my-deliveries',
      label: 'platform.nav.myDeliveries',
      icon: Truck,
      group: 'operations',
      feature: 'orders',
      permission: 'orders.delivery.use',
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
      // Shown while the user can import at least one kind (each needs its module's key, docs/platform/import.md).
      children: [
        ['categories', 'catalog', 'catalog.products.create'],
        ['items', 'inventory', 'inventory.items.create'],
        ['opening-stock', 'inventory', 'inventory.stock.receive'],
        ['customers', 'orders', 'orders.customers.create'],
      ].map(([kind, feature, permission]) => ({
        id: `import-${kind}`,
        href: '/import',
        label: 'platform.nav.importData',
        icon: Download,
        group: 'tools',
        feature: feature as FeatureKey,
        permission: permission as PermissionKey,
      })),
    },
    FEEDBACK,
  ],
};

/**
 * The operations menu of a branch (ADR 0059), as AsiaMight's branches know it: Inventory (with the request cart),
 * Order History (the branch's requests), Delivery Tracking (what is on its way to the branch) and Feedback.
 */
const BRANCH: NavLayoutDefinition = {
  groups: [
    { id: 'operations', label: 'platform.nav.groups.operations' },
    { id: 'tools', label: 'platform.nav.groups.tools' },
  ],
  items: [
    { ...inventory, icon: Archive, group: 'operations', children: undefined },
    {
      id: 'order-history',
      href: '/requests',
      label: 'platform.nav.orderHistory',
      icon: Package,
      group: 'operations',
      feature: 'orders',
      permission: 'orders.requests.read',
    },
    {
      id: 'branch-deliveries',
      href: '/deliveries',
      label: 'platform.nav.deliveries',
      icon: MapPin,
      group: 'operations',
      feature: 'orders',
      permission: 'orders.requests.receive',
    },
    FEEDBACK,
  ],
};

/**
 * Someone who works for a branch (ADR 0059, the Branch manager role): asks the main warehouse for goods, and neither
 * approves requests nor handles sales orders. UI hint only, like the menu.
 */
export function isBranchView(access: NavAccess): boolean {
  const holds = (key: PermissionKey) => access.activePermissions.includes(key);
  return (
    holds('orders.requests.create') &&
    !holds('orders.requests.approve') &&
    !holds('orders.orders.read')
  );
}

const DEFAULT: NavLayoutDefinition = { groups: NAV_GROUPS, items: NAV_ITEMS };

/**
 * The sidebar for a partner theme's layout (ADR 0044), and in the operations layout for a branch its own menu (ADR
 * 0059); unknown or absent → Durby's menu.
 */
export function navLayout(layout: NavLayout | undefined, access?: NavAccess): NavLayoutDefinition {
  if (layout !== 'operations') return DEFAULT;
  return access && isBranchView(access) ? BRANCH : OPERATIONS;
}

/** For tests: the branch menu of the operations layout. */
export const BRANCH_NAV_LAYOUT: NavLayoutDefinition = BRANCH;

/** For tests: every layout. */
export const NAV_LAYOUT_DEFINITIONS: Readonly<Record<NavLayout, NavLayoutDefinition>> = {
  default: DEFAULT,
  operations: OPERATIONS,
};
