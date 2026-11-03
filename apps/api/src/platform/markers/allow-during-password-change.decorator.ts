import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export const ALLOW_DURING_PASSWORD_CHANGE_KEY = 'durby:allowDuringPasswordChange';

/**
 * The route stays open to a session whose password must be changed first (ADR 0023 §3): only the
 * password change itself, `/auth/me` and logout. An extra flag next to the route's access marker,
 * not a marker itself; every other authenticated route answers 403 auth.password_change_required
 * to such a session.
 */
export const AllowDuringPasswordChange = (): MethodDecorator =>
  SetMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, true);

export function allowsDuringPasswordChange(reflector: Reflector, handler: object): boolean {
  return (
    reflector.get<boolean | undefined>(ALLOW_DURING_PASSWORD_CHANGE_KEY, handler as never) === true
  );
}
