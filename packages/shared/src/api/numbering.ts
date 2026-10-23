import { z } from 'zod';
import { NUMBER_PERIOD_PATTERN, NUMBER_RESET_POLICIES, NUMBER_SERIES_KEYS } from '../numbering';

/** /api/v1/number-series (docs/platform/numbering.md → API). */

const MAX_BIGINT = '9223372036854775807';

/** A counter value: digits, ≥ 1, within Postgres bigint. JSON carries it as a string (ADR 0012 §11). */
export const counterValueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  // Same-length digit strings compare like numbers; zod runs this even when the regex failed.
  .refine((v) => v.length < 19 || (v.length === 19 && v <= MAX_BIGINT), { message: 'Too large' });

/** Prefix and pattern rules are checked by the api (422 numbering.invalid_*), with problem codes. */
export const patchNumberSeriesRequestSchema = z
  .strictObject({
    prefix: z.string().max(100).optional(),
    pattern: z.string().max(200).optional(),
    resetPolicy: z.enum(NUMBER_RESET_POLICIES).optional(),
  })
  .refine((b) => b.prefix !== undefined || b.pattern !== undefined || b.resetPolicy !== undefined, {
    message: 'Change at least one field',
  });

export const putNumberSeriesCounterRequestSchema = z.strictObject({
  nextValue: counterValueSchema,
  /** Defaults to the current period. */
  period: z.string().regex(NUMBER_PERIOD_PATTERN).optional(),
});

export const numberSeriesSchema = z.object({
  key: z.enum(NUMBER_SERIES_KEYS),
  prefix: z.string(),
  pattern: z.string(),
  resetPolicy: z.enum(NUMBER_RESET_POLICIES),
  /** The current period (now, in the organization's time zone). */
  period: z.string(),
  /** The next number to issue in that period. */
  nextValue: counterValueSchema,
  /** The number `nextValue` would render as now. */
  preview: z.string(),
});

export const numberSeriesListResponseSchema = z.object({
  /** Series whose feature is enabled, in registry order. */
  data: z.array(numberSeriesSchema),
});

export type PatchNumberSeriesRequest = z.infer<typeof patchNumberSeriesRequestSchema>;
export type PutNumberSeriesCounterRequest = z.infer<typeof putNumberSeriesCounterRequestSchema>;
export type NumberSeries = z.infer<typeof numberSeriesSchema>;
export type NumberSeriesListResponse = z.infer<typeof numberSeriesListResponseSchema>;

/** Stable error codes of number series; the web app shows the matching label. */
export const NUMBERING_ERROR_CODES = [
  'numbering.unknown_key',
  'numbering.invalid_prefix',
  'numbering.invalid_pattern',
  'numbering.invalid_period',
  'numbering.series_in_use',
  'numbering.counter_backwards',
] as const;

export type NumberingErrorCode = (typeof NUMBERING_ERROR_CODES)[number];

/** `numbering.unknown_key` → `platform.errors.numberingUnknownKey`. */
export function numberingErrorLabel(code: NumberingErrorCode): string {
  return `platform.errors.${code.replace(/[._]([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
