import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, PermissionKey } from '@durby/shared';
import {
  Building2,
  ClipboardList,
  ChartLine,
  CreditCard,
  Hash,
  House,
  Languages,
  Layers,
  LayoutGrid,
  type LucideIcon,
  Package,
  Receipt,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  UtensilsCrossed,
} from 'lucide-react';

export type NavGroup = 'main' | 'modules' | 'settings';

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
}

/** Group headings in display order; `main` has none. */
export const NAV_GROUPS: readonly { id: NavGroup; label: LabelKey | null }[] = [
  { id: 'main', label: null },
  { id: 'modules', label: 'platform.nav.groups.modules' },
  { id: 'settings', label: 'platform.nav.groups.settings' },
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
  },
  {
    id: 'pos',
    href: '/pos',
    label: 'pos.nav.title',
    icon: CreditCard,
    group: 'modules',
    feature: 'pos',
  },
  {
    id: 'tables',
    href: '/pos/tables',
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
  },
  {
    id: 'organization',
    href: '/settings/organization',
    label: 'platform.nav.organization',
    icon: Building2,
    group: 'settings',
  },
  {
    id: 'settings',
    href: '/settings/general',
    label: 'platform.nav.settings',
    icon: SlidersHorizontal,
    group: 'settings',
    permission: 'platform.settings.read',
  },
  {
    id: 'members',
    href: '/settings/members',
    label: 'platform.nav.members',
    icon: Users,
    group: 'settings',
    permission: 'platform.users.read',
  },
  {
    id: 'roles',
    href: '/settings/roles',
    label: 'platform.nav.roles',
    icon: ShieldCheck,
    group: 'settings',
    permission: 'platform.roles.read',
  },
  {
    id: 'labels',
    href: '/settings/labels',
    label: 'platform.nav.labels',
    icon: Languages,
    group: 'settings',
    permission: 'platform.labels.manage',
  },
  {
    id: 'numbering',
    href: '/settings/numbering',
    label: 'platform.nav.numbering',
    icon: Hash,
    group: 'settings',
    permission: 'platform.settings.read',
  },
  {
    id: 'plan',
    href: '/settings/plan',
    label: 'platform.nav.plan',
    icon: Layers,
    group: 'settings',
  },
  {
    id: 'audit',
    href: '/settings/audit',
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
      (item.feature === undefined || access.activeFeatures.includes(item.feature)) &&
      (item.permission === undefined || access.activePermissions.includes(item.permission)),
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
