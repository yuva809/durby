import type { LabelKey } from '@durby/i18n';
import type { FeatureKey, PermissionKey } from '@durby/shared';
import { SlidersHorizontal } from 'lucide-react';
import type { NavItem } from './registry';

/**
 * The tabs of Settings (one sidebar item, docs/platform/web-shell.md → Settings): the same pages
 * and the same permission rules as the former settings items. Order is display order; /settings
 * opens the first one the user may see.
 */
const tab = (
  id: string,
  label: LabelKey,
  permission?: PermissionKey,
  feature?: FeatureKey,
): NavItem => ({
  id,
  href: `/settings/${id}`,
  label,
  icon: SlidersHorizontal,
  group: 'settings',
  ...(permission && { permission }),
  ...(feature && { feature }),
});

export const SETTINGS_TABS: readonly NavItem[] = [
  // The organization's name: every built-in role reads it (platform.org.read, ADR 0051), owners change it.
  tab('organization', 'platform.settingsTabs.company', 'platform.org.read'),
  tab('locations', 'platform.settingsTabs.locations', 'platform.settings.read'),
  tab('general', 'platform.settingsTabs.general', 'platform.settings.read'),
  // Tables, combinations (R1.5b) and the location's reservation settings (R1.5c).
  tab('reservations', 'reservations.settingsPage.tab', 'reservations.setup.edit', 'reservations'),
  tab('numbering', 'platform.settingsTabs.numbering', 'platform.settings.read'),
  // The printed bill's header and footer (docs/modules/pos.md → Bill layout).
  tab('bill', 'platform.settingsTabs.bill', 'platform.settings.read', 'pos'),
  // The LAN printer each location prints bills on through the Android app (ADR 0032).
  tab('printers', 'platform.settingsTabs.printers', 'platform.settings.read', 'pos'),
  // This device's own settings, kept by the Android app (ADR 0033 §5, §13): only inside the app.
  { ...tab('device', 'platform.settingsTabs.device', 'pos.bills.print', 'pos'), appOnly: true },
  // Whether the kitchen and the bar prepare orders, or items go straight to the bill (ADR 0031).
  tab('service', 'platform.settingsTabs.service', 'platform.settings.read', 'pos'),
  tab('labels', 'platform.settingsTabs.labels', 'platform.labels.manage'),
  tab('plan', 'platform.settingsTabs.plan'),
];
