import type { Translator } from '@durby/i18n';
import type { RoleRef } from '@durby/shared';
import { t as defaults } from '../i18n';

/**
 * Display name of a role: the `platform.roles.<key>` label for system roles, else its own name.
 * Signed-in UI passes its useT() translator; public pages use the bundled defaults.
 */
export function roleName(
  role: Pick<RoleRef, 'systemKey' | 'name'>,
  t: Translator = defaults,
): string {
  return role.systemKey ? t(`platform.roles.${role.systemKey}`) : (role.name ?? '');
}
