import { describe, expect, it } from 'vitest';
import {
  putSettingRequestSchema,
  SETTING_ERROR_CODES,
  settingErrorLabel,
  settingScopeQuerySchema,
  settingsResponseSchema,
} from './settings';

const id = '0192f1a0-0000-7000-8000-000000000001';

describe('settings API schemas', () => {
  it('takes brandId or locationId, not both and nothing else', () => {
    expect(settingScopeQuerySchema.safeParse({}).success).toBe(true);
    expect(settingScopeQuerySchema.safeParse({ brandId: id }).success).toBe(true);
    expect(settingScopeQuerySchema.safeParse({ locationId: id }).success).toBe(true);
    expect(settingScopeQuerySchema.safeParse({ brandId: id, locationId: id }).success).toBe(false);
    expect(settingScopeQuerySchema.safeParse({ locationId: 'nope' }).success).toBe(false);
    expect(settingScopeQuerySchema.safeParse({ tenantId: id }).success).toBe(false);
  });

  it('needs a JSON value in the body', () => {
    expect(putSettingRequestSchema.safeParse({ value: 'fifo' }).success).toBe(true);
    expect(putSettingRequestSchema.safeParse({ value: false }).success).toBe(true);
    expect(putSettingRequestSchema.safeParse({}).success).toBe(false);
    expect(putSettingRequestSchema.safeParse({ value: 1, scope: 'x' }).success).toBe(false);
  });

  it('describes resolved settings', () => {
    const body = {
      data: [{ key: 'currency', value: 'EUR', source: 'default', dataBound: true }],
    };
    expect(settingsResponseSchema.parse(body)).toEqual(body);
    expect(
      settingsResponseSchema.safeParse({
        data: [{ key: 'nope', value: 1, source: 'default', dataBound: false }],
      }).success,
    ).toBe(false);
  });

  it('maps error codes to label keys', () => {
    expect(settingErrorLabel('settings.unknown_key')).toBe('platform.errors.settingsUnknownKey');
    expect(settingErrorLabel('settings.in_use')).toBe('platform.errors.settingsInUse');
    expect(SETTING_ERROR_CODES).toHaveLength(6);
  });
});
