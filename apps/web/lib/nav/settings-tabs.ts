import type { LabelKey } from '@durby/i18n';
import type { PermissionKey } from '@durby/shared';
import { SlidersHorizontal } from 'lucide-react';
import type { NavItem } from './registry';

/**
 * The tabs of Settings (one sidebar item, docs/platform/web-shell.md → Settings): the same pages
 * and the same permission rules as the former settings items. Order is display order; /settings
 * opens the first one the user may see.
 */
const tab = (id: string, label: LabelKey, permission?: PermissionKey): NavItem => ({
  id,
  href: `/settings/${id}`,
  label,
  icon: SlidersHorizontal,
  group: 'settings',
  ...(permission && { permission }),
});

export const SETTINGS_TABS: readonly NavItem[] = [
  // The organization's name: everyone reads it, owners change it.
  tab('organization', 'platform.settingsTabs.company'),
  tab('locations', 'platform.settingsTabs.locations', 'platform.settings.read'),
  tab('members', 'platform.settingsTabs.members', 'platform.users.read'),
  tab('roles', 'platform.settingsTabs.roles', 'platform.roles.read'),
  tab('general', 'platform.settingsTabs.general', 'platform.settings.read'),
  tab('numbering', 'platform.settingsTabs.numbering', 'platform.settings.read'),
  tab('labels', 'platform.settingsTabs.labels', 'platform.labels.manage'),
  tab('plan', 'platform.settingsTabs.plan'),
];
