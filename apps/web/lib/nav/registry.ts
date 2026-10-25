import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, PermissionKey } from '@durby/shared';
import {
  ChartLine,
  CreditCard,
  House,
  type LucideIcon,
  Package,
  Receipt,
  ShieldCheck,
  Users,
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
    id: 'reports',
    href: '/reports',
    label: 'reports.nav.title',
    icon: ChartLine,
    group: 'modules',
    feature: 'reports',
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

/** The item for a path: exact match for `/`, prefix match (by segment) for the others. */
export function activeNavItem(items: readonly NavItem[], pathname: string): NavItem | undefined {
  return items.find((item) =>
    item.href === '/'
      ? pathname === '/'
      : pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
