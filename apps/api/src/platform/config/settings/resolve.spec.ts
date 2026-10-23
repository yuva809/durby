import { SETTING_KEYS, SETTINGS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  resolveSettings,
  type SettingRows,
  type SettingTarget,
  type TenantSettingRow,
} from './resolve';

const BRAND = '0192f1a0-0000-7000-8000-00000000000b';
const OTHER_BRAND = '0192f1a0-0000-7000-8000-00000000000c';
const LOCATION = '0192f1a0-0000-7000-8000-00000000001a';
const OTHER_LOCATION = '0192f1a0-0000-7000-8000-00000000001b';

const org = (key: string, value: unknown): TenantSettingRow => ({
  scopeType: 'organization',
  brandId: null,
  locationId: null,
  key,
  value,
});
const brand = (key: string, value: unknown, brandId = BRAND): TenantSettingRow => ({
  scopeType: 'brand',
  brandId,
  locationId: null,
  key,
  value,
});
const location = (key: string, value: unknown, locationId = LOCATION): TenantSettingRow => ({
  scopeType: 'location',
  brandId: null,
  locationId,
  key,
  value,
});

function resolve(
  rows: Partial<SettingRows>,
  target: SettingTarget = { brandId: BRAND, locationId: LOCATION },
) {
  const ignored: string[] = [];
  const resolved = resolveSettings(
    { partner: rows.partner ?? [], tenant: rows.tenant ?? [] },
    target,
    (problem) => ignored.push(problem),
  );
  return { resolved, ignored };
}

describe('resolveSettings', () => {
  it('falls back to the code defaults, in registry order', () => {
    const { resolved, ignored } = resolve({});
    expect([...resolved.keys()]).toEqual(SETTING_KEYS);
    for (const key of SETTING_KEYS) {
      expect(resolved.get(key)).toEqual({ value: SETTINGS[key].default, source: 'default' });
    }
    expect(ignored).toEqual([]);
  });

  it('resolves location → brand → organization → partner → default', () => {
    const partner = [{ key: 'timezone', value: 'Europe/Vienna' }];
    const levels: TenantSettingRow[] = [
      org('timezone', 'Europe/Zurich'),
      brand('timezone', 'Europe/Paris'),
      location('timezone', 'Europe/London'),
    ];
    const at = (rows: TenantSettingRow[]) => resolve({ partner, tenant: rows }).resolved;
    expect(at(levels).get('timezone')).toEqual({ value: 'Europe/London', source: 'location' });
    expect(at(levels.slice(0, 2)).get('timezone')).toEqual({
      value: 'Europe/Paris',
      source: 'brand',
    });
    expect(at(levels.slice(0, 1)).get('timezone')).toEqual({
      value: 'Europe/Zurich',
      source: 'organization',
    });
    expect(at([]).get('timezone')).toEqual({ value: 'Europe/Vienna', source: 'partner' });
  });

  it('uses only the target brand and location, never another one', () => {
    const { resolved } = resolve({
      tenant: [
        org('timezone', 'Europe/Zurich'),
        brand('timezone', 'Europe/Paris', OTHER_BRAND),
        location('timezone', 'Europe/London', OTHER_LOCATION),
      ],
    });
    expect(resolved.get('timezone')).toEqual({ value: 'Europe/Zurich', source: 'organization' });
  });

  it('skips brand and location levels at organization scope', () => {
    const { resolved } = resolve(
      { tenant: [brand('locale', 'de'), location('locale', 'de')] },
      { brandId: null, locationId: null },
    );
    expect(resolved.get('locale')).toEqual({ value: 'en', source: 'default' });
  });

  it('applies brand values to a brand-level target without a location', () => {
    const { resolved } = resolve(
      { tenant: [brand('locale', 'de'), location('locale', 'en')] },
      { brandId: BRAND, locationId: null },
    );
    expect(resolved.get('locale')).toEqual({ value: 'de', source: 'brand' });
  });

  it('falls through an invalid stored value to the next level and reports it', () => {
    const { resolved, ignored } = resolve({
      partner: [{ key: 'currency', value: 'CHF' }],
      tenant: [
        org('currency', 'Euro'),
        location('inventory.allowNegativeStock', 'yes'),
        org('inventory.allowNegativeStock', true),
      ],
    });
    expect(resolved.get('currency')).toEqual({ value: 'CHF', source: 'partner' });
    expect(resolved.get('inventory.allowNegativeStock')).toEqual({
      value: true,
      source: 'organization',
    });
    // Reported in registry order.
    expect(ignored).toEqual([
      'invalid organization value of currency',
      'invalid location value of inventory.allowNegativeStock',
    ]);
  });

  it('ignores a value stored at a scope the key no longer allows', () => {
    const { resolved, ignored } = resolve({
      tenant: [location('currency', 'USD'), org('currency', 'CHF')],
    });
    expect(resolved.get('currency')).toEqual({ value: 'CHF', source: 'organization' });
    expect(ignored).toEqual(['currency is not allowed at location scope']);
  });

  it('ignores and reports unregistered keys', () => {
    const { resolved, ignored } = resolve({
      partner: [{ key: 'legacy.flag', value: 1 }],
      tenant: [org('toString', 'x')],
    });
    expect(resolved.has('legacy.flag' as never)).toBe(false);
    expect(ignored).toEqual([
      'unregistered setting key legacy.flag',
      'unregistered setting key toString',
    ]);
  });
});
