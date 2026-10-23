import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../http';

/** Error codes of platform/config/entitlements (docs/platform/entitlements.md). */
export const entitlementsErrors = {
  featureDisabled: (feature: string) =>
    new ApiError(
      HttpStatus.FORBIDDEN,
      'entitlements.feature_disabled',
      'This feature is not included in your plan.',
      { feature },
    ),
} as const;
