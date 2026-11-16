import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, PermissionKey } from '@durby/shared';
import {
  CalendarClock,
  CalendarDays,
  ChefHat,
  ClipboardList,
  ConciergeBell,
  ReceiptText,
  ChartLine,
  CreditCard,
  House,
  LayoutGrid,
  type LucideIcon,
  Package,
  Receipt,
  SlidersHorizontal,
  UsersRound,
  UtensilsCrossed,
  Wine,
} from 'lucide-react';
import { INVENTORY_PAGES } from './inventory-pages';
import { SETTINGS_TABS } from './settings-tabs';

/** `operations`, `administration` and `tools`: the groups of the operations layout (ADR 0044). */
export type NavGroup = 'main' | 'modules' | 'settings' | 'operations' | 'administration' | 'tools';

export interface NavItem {
  id: string;
  href: string;
  label: LabelKey;
  icon: LucideIcon;
  group: NavGroup;
  /** Shown only while the active organization has this feature. */
  feature?: FeatureKey;
  /** Shown only while the user holds this permission in the active organization. */
  permission?: PermissionKey;
  /**
   * A module that isn't built yet: its route shows a placeholder, the menu hides it. Remove the flag
   * when the module ships.
   */
  planned?: true;
  /** Only inside the Android app (Settings → This device): its settings live in the app. */
  appOnly?: true;
  /** Pages behind this item (e.g. the Settings tabs): shown while at least one of them is. */
  children?: readonly NavItem[];
  /** The children are listed under the item in the sidebar (Inventory), not as tabs of one page. */
  submenu?: true;
}

/** Group headings in display order; `main` has none. */
export const NAV_GROUPS: readonly { id: NavGroup; label: LabelKey | null }[] = [
  { id: 'main', label: null },
  { id: 'modules', label: 'platform.nav.groups.modules' },
  // One Settings item (its pages are tabs, lib/nav/settings-tabs.ts): no heading needed.
  { id: 'settings', label: null },
];

/**
 * Navigation of the signed-in shell (docs/platform/web-shell.md → Nav registry). PRs (b)–(d) add
 * their settings items here as their pages land.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', href: '/', label: 'platform.nav.home', icon: House, group: 'main' },
  {
    id: 'inventory',
    href: '/inventory',
    label: 'inventory.nav.title',
    icon: Package,
    group: 'modules',
    feature: 'inventory',
    // Stock, documents and setup (docs/modules/inventory.md → Web), with its pages listed under it.
    permission: 'inventory.stock.read',
    children: INVENTORY_PAGES,
    submenu: true,
  },
  {
    id: 'catalog',
    href: '/catalog',
    label: 'catalog.nav.title',
    icon: UtensilsCrossed,
    group: 'modules',
    feature: 'catalog',
    permission: 'catalog.products.read',
  },
  {
    id: 'billing',
    href: '/billing',
    label: 'billing.nav.title',
    icon: Receipt,
    group: 'modules',
    feature: 'billing',
    planned: true,
  },
  {
    id: 'pos',
    href: '/pos',
    label: 'pos.nav.title',
    icon: CreditCard,
    group: 'modules',
    feature: 'pos',
    planned: true,
  },
  {
    // Table service: the floor and the till per table (docs/modules/pos.md → Web).
    id: 'service',
    href: '/service',
    label: 'pos.nav.service',
    icon: ConciergeBell,
    group: 'modules',
    feature: 'pos',
    permission: 'pos.orders.read',
  },
  {
    // The billing counter: open tables and guest checks (docs/modules/pos.md → Step 4).
    id: 'checkout',
    href: '/checkout',
    label: 'pos.nav.checkout',
    icon: ReceiptText,
    group: 'modules',
    feature: 'pos',
    permission: 'pos.bills.print',
  },
  {
    // The kitchen and bar screens (docs/modules/pos.md → Kitchen and bar screens, ADR 0026).
    id: 'kitchen',
    href: '/kitchen',
    label: 'pos.nav.kitchen',
    icon: ChefHat,
    group: 'modules',
    feature: 'pos',
    permission: 'pos.kitchen.use',
  },
  {
    id: 'bar',
    href: '/bar',
    label: 'pos.nav.bar',
    icon: Wine,
    group: 'modules',
    feature: 'pos',
    permission: 'pos.bar.use',
  },
  {
    // The door: bookings, walk-ins and the floor (docs/modules/reservations.md → Web).
    id: 'host',
    href: '/host',
    label: 'reservations.nav.host',
    icon: CalendarClock,
    group: 'modules',
    feature: 'reservations',
    permission: 'reservations.bookings.read',
  },
  {
    // Bookings over a few days: search, edit, cancel (docs/modules/reservations.md → Web, R1.9).
    id: 'reservations',
    href: '/reservations',
    label: 'reservations.nav.reservations',
    icon: CalendarDays,
    group: 'modules',
    feature: 'reservations',
    permission: 'reservations.bookings.read',
  },
  {
    id: 'tables',
    href: '/tables',
    label: 'pos.nav.tables',
    icon: LayoutGrid,
    group: 'modules',
    feature: 'pos',
    permission: 'pos.tables.read',
  },
  {
    id: 'reports',
    href: '/reports',
    label: 'reports.nav.title',
    icon: ChartLine,
    group: 'modules',
    feature: 'reports',
    planned: true,
  },
  {
    // Its own item, not a Settings tab (docs/platform/rbac.md → Manage Staff).
    id: 'staff',
    href: '/staff',
    label: 'platform.nav.staff',
    icon: UsersRound,
    group: 'settings',
    permission: 'platform.users.read',
  },
  {
    // Company, Locations, Roles, … as tabs of one page (lib/nav/settings-tabs.ts).
    id: 'settings',
    href: '/settings',
    label: 'platform.nav.settings',
    icon: SlidersHorizontal,
    group: 'settings',
    children: SETTINGS_TABS,
  },
  {
    // Its own item, not a Settings tab (docs/platform/web-shell.md → Audit log viewer).
    id: 'audit',
    href: '/audit',
    label: 'platform.nav.audit',
    icon: ClipboardList,
    group: 'settings',
    permission: 'platform.audit.read',
  },
];

export interface NavAccess {
  activeFeatures: readonly string[];
  activePermissions: readonly string[];
}

/**
 * The items to show. Features and permissions come from the session and are UI hints only: the
 * api checks @RequireFeature and @RequirePermission on every request.
 */
export function visibleNav(items: readonly NavItem[], access: NavAccess): NavItem[] {
  return items.filter(
    (item) =>
      !item.planned &&
      (item.feature === undefined || access.activeFeatures.includes(item.feature)) &&
      (item.permission === undefined || access.activePermissions.includes(item.permission)) &&
      (item.children === undefined || visibleNav(item.children, access).length > 0),
  );
}

/**
 * The item for a path: exact match for `/`, prefix match (by segment) for the others; the longest
 * match wins, so `/pos/tables` is Tables, not POS.
 */
export function activeNavItem(items: readonly NavItem[], pathname: string): NavItem | undefined {
  return items
    .filter((item) =>
      item.href === '/'
        ? pathname === '/'
        : pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .reduce<NavItem | undefined>(
      (best, item) => (best && best.href.length >= item.href.length ? best : item),
      undefined,
    );
}
