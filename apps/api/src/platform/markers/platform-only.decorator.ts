import { SetMetadata } from '@nestjs/common';

export const IS_PLATFORM_ONLY_KEY = 'durby:isPlatformOnly';

/**
 * A route for Durby platform staff (operators across tenants), not for tenant users (ADR 0007).
 * Platform staff isn't modelled yet, so the guard denies every request to these routes.
 */
export const PlatformOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PLATFORM_ONLY_KEY, true);
