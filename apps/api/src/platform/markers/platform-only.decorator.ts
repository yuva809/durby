import { SetMetadata } from '@nestjs/common';
import type { StaffPermissionKey } from '@durby/shared';

export const IS_PLATFORM_ONLY_KEY = 'durby:isPlatformOnly';

export interface PlatformOnlyOptions {
  /** Sensitive action: needs a password + TOTP confirmation in the last 15 minutes (ADR 0017 §3). */
  fresh?: boolean;
}

export interface PlatformOnlyMetadata {
  key: string;
  fresh: boolean;
}

/**
 * A route for Durby staff, not for customer users (ADR 0007, ADR 0017 §3): authenticated only by
 * the staff session cookie, and allowed when the staff member's role holds `key` (a staff
 * permission key; the api refuses to boot on an unregistered one).
 */
export const PlatformOnly = (
  key: StaffPermissionKey,
  options: PlatformOnlyOptions = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PLATFORM_ONLY_KEY, {
    key,
    fresh: options.fresh ?? false,
  } satisfies PlatformOnlyMetadata);
