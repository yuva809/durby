import { z } from 'zod';
import { SETTING_KEYS, SETTING_SOURCES } from '../settings';

/** /api/v1/settings (docs/platform/settings.md → API). */

/** The scope of a call: none = organization, `brandId` = brand, `locationId` = location. */
export const settingScopeQuerySchema = z
  .strictObject({
    brandId: z.uuid().optional(),
    locationId: z.uuid().optional(),
  })
  .refine((q) => q.brandId === undefined || q.locationId === undefined, {
    message: 'Pass brandId or locationId, not both',
    path: ['locationId'],
  });

export const putSettingRequestSchema = z.strictObject({
  /** Validated against the key's schema by the api (422 settings.invalid_value). */
  value: z.json(),
});

export const resolvedSettingSchema = z.object({
  key: z.enum(SETTING_KEYS),
  value: z.json(),
  source: z.enum(SETTING_SOURCES),
  dataBound: z.boolean(),
});

export const settingsResponseSchema = z.object({
  /** Every registered key, in registry order. */
  data: z.array(resolvedSettingSchema),
});

export type SettingScopeQuery = z.infer<typeof settingScopeQuerySchema>;
export type PutSettingRequest = z.infer<typeof putSettingRequestSchema>;
export type ResolvedSetting = z.infer<typeof resolvedSettingSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/** Stable error codes of settings; the web app shows the matching label. */
export const SETTING_ERROR_CODES = [
  'settings.unknown_key',
  'settings.scope_not_allowed',
  'settings.invalid_value',
  'settings.brand_not_found',
  'settings.location_not_found',
  'settings.in_use',
] as const;

export type SettingErrorCode = (typeof SETTING_ERROR_CODES)[number];

/** `settings.unknown_key` → `platform.errors.settingsUnknownKey`. */
export function settingErrorLabel(code: SettingErrorCode): string {
  return `platform.errors.${code.replace(/[._]([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
