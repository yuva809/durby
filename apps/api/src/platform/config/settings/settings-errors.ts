import { HttpStatus } from '@nestjs/common';
import type { SettingScope } from '@durby/shared';
import { ApiError, type ValidationIssue } from '../../http';

/** Error codes of platform/config/settings (docs/platform/settings.md → Errors). */
export const settingsErrors = {
  unknownKey: (key: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'settings.unknown_key', 'Unknown setting.', { key }),
  scopeNotAllowed: (key: string, scope: SettingScope, allowed: readonly SettingScope[]) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'settings.scope_not_allowed',
      'This setting cannot be set at this scope.',
      { key, scope, allowed },
    ),
  /** Issues carry path/code/message only, never the value. */
  invalidValue: (key: string, issues: ValidationIssue[]) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'settings.invalid_value',
      'Invalid value for this setting.',
      { key, issues },
    ),
  brandNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'settings.brand_not_found', 'Brand not found.'),
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'settings.location_not_found', 'Location not found.'),
  inUse: (key: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'settings.in_use',
      'Data recorded with this setting depends on it.',
      { key },
    ),
} as const;
