import { LOCALES } from '@durby/i18n';
import { z } from 'zod';

/** /api/v1/labels and /api/v1/label-overrides (docs/platform/labels.md → API). */

export const labelsQuerySchema = z.strictObject({
  /** Defaults to the user's locale. */
  locale: z.enum(LOCALES).optional(),
});

export const labelsResponseSchema = z.object({
  locale: z.enum(LOCALES),
  /** Every label key, resolved for the current organization. */
  data: z.record(z.string(), z.string()),
});

export const labelOverridesQuerySchema = z.strictObject({
  locale: z.enum(LOCALES).optional(),
});

export const putLabelOverrideRequestSchema = z.strictObject({
  /** Checked against the key's default text by the api (422 labels.invalid_value). */
  value: z.string(),
});

export const labelOverrideSchema = z.object({
  locale: z.enum(LOCALES),
  key: z.string(),
  value: z.string(),
  defaultValue: z.string(),
  /** false: stored but skipped on read (no longer overridable or valid); remove it. */
  active: z.boolean(),
});

export const labelOverridesResponseSchema = z.object({
  /** Sorted by key, then locale. */
  data: z.array(labelOverrideSchema),
});

export type LabelsQuery = z.infer<typeof labelsQuerySchema>;
export type LabelsResponse = z.infer<typeof labelsResponseSchema>;
export type LabelOverridesQuery = z.infer<typeof labelOverridesQuerySchema>;
export type PutLabelOverrideRequest = z.infer<typeof putLabelOverrideRequestSchema>;
export type LabelOverride = z.infer<typeof labelOverrideSchema>;
export type LabelOverridesResponse = z.infer<typeof labelOverridesResponseSchema>;

/** Stable error codes of labels; the web app shows the matching label. */
export const LABEL_ERROR_CODES = [
  'labels.unknown_locale',
  'labels.unknown_key',
  'labels.not_overridable',
  'labels.invalid_value',
] as const;

export type LabelErrorCode = (typeof LABEL_ERROR_CODES)[number];

/** `labels.not_overridable` → `platform.errors.labelsNotOverridable`. */
export function labelErrorLabel(code: LabelErrorCode): string {
  return `platform.errors.${code.replace(/[._]([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
