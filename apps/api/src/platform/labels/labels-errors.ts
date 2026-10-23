import { HttpStatus } from '@nestjs/common';
import type { OverrideCheck } from '@durby/i18n';
import { ApiError } from '../http';

/** Error codes of platform/labels (docs/platform/labels.md → Errors). */
export const labelsErrors = {
  unknownLocale: (locale: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'labels.unknown_locale', 'Unsupported locale.', { locale }),
  unknownKey: (key: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'labels.unknown_key', 'Unknown label.', { key }),
  notOverridable: (key: string) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'labels.not_overridable',
      'Organizations cannot change this label.',
      { key },
    ),
  /** Details carry the reason and placeholder names only, never the value. */
  invalidValue: (key: string, locale: string, check: Extract<OverrideCheck, { ok: false }>) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'labels.invalid_value',
      'Invalid text for this label.',
      check.reason === 'placeholders'
        ? { key, locale, reason: check.reason, expected: check.expected, found: check.found }
        : { key, locale, reason: check.reason },
    ),
} as const;
