import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FeatureKey } from '@durby/shared';

export const REQUIRED_FEATURE_KEY = 'durby:requiredFeature';

/**
 * The route needs `key` enabled for the active organization (docs/platform/entitlements.md). An
 * extra check next to the route's access marker, not a marker itself: only valid with
 * @RequirePermission (checked at boot). On the handler and/or the controller; both must hold.
 */
export const RequireFeature = (key: FeatureKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_FEATURE_KEY, key);

/** The feature keys on the handler and on its controller class (may be unregistered). */
export function featuresOf(reflector: Reflector, handler: object, controller: object): string[] {
  return [handler, controller]
    .map((target) => reflector.get<string | undefined>(REQUIRED_FEATURE_KEY, target as never))
    .filter((key): key is string => key !== undefined);
}
