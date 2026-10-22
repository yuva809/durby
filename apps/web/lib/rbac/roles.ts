import type { RoleRef } from '@durby/shared';
import { t } from '../i18n';

/** Display name of a role: the `platform.roles.<key>` label for system roles, else its own name. */
export function roleName(role: Pick<RoleRef, 'systemKey' | 'name'>): string {
  return role.systemKey ? t(`platform.roles.${role.systemKey}`) : (role.name ?? '');
}
