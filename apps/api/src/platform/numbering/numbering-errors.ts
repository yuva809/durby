import { HttpStatus } from '@nestjs/common';
import type { NumberPatternProblem } from '@durby/shared';
import { ApiError } from '../http';

/** Error codes of platform/numbering (docs/platform/numbering.md → Errors). */
export const numberingErrors = {
  unknownKey: (key: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'numbering.unknown_key', 'Unknown number series.', { key }),
  invalidPrefix: (problems: NumberPatternProblem[]) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'numbering.invalid_prefix',
      'Invalid prefix for this number series.',
      { problems },
    ),
  invalidPattern: (problems: NumberPatternProblem[]) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'numbering.invalid_pattern',
      'Invalid pattern for this number series.',
      { problems },
    ),
  invalidPeriod: (period: string) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'numbering.invalid_period',
      'This period does not fit the number series.',
      { period },
    ),
  seriesInUse: (key: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'numbering.series_in_use',
      'Numbers were already issued in this series.',
      { key },
    ),
  counterBackwards: (period: string, nextValue: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'numbering.counter_backwards',
      'The next number can only be raised.',
      { period, nextValue },
    ),
} as const;
