import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, PermissionKey } from '@durby/shared';
import { ChartLine } from 'lucide-react';
import type { NavItem } from './registry';

/**
 * The tabs of Reports (one sidebar item, docs/modules/reports.md). Each needs its module too, so an organization with
 * reports but neither till nor reservations (a distributor) has no Reports item.
 */
const tab = (
  id: string,
  href: string,
  label: LabelKey,
  permission: PermissionKey,
  feature: FeatureKey,
): NavItem => ({ id, href, label, icon: ChartLine, group: 'modules', permission, feature });

export const REPORT_TABS: readonly NavItem[] = [
  tab('report-sales', '/reports', 'reports.tabs.sales', 'reports.sales.read', 'pos'),
  tab('report-tables', '/reports/tables', 'reports.tabs.tables', 'reports.sales.read', 'pos'),
  tab(
    'report-reservations',
    '/reports/reservations',
    'reports.tabs.reservations',
    'reports.reservations.read',
    'reservations',
  ),
];
