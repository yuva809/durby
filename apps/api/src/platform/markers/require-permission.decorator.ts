import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@durby/shared';

export const REQUIRED_PERMISSION_KEY = 'durby:requiredPermission';

/**
 * The route needs a valid access token, an active organization and `key` (CLAUDE.md rule 10,
 * docs/platform/rbac.md). For a location-scope key the guard only checks that the caller holds it
 * for some location; the handler asserts the specific one with AccessService.
 */
export const RequirePermission = (key: PermissionKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, key);
