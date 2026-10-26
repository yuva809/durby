import { dictionaries, isLabelKey, LOCALES } from '@durby/i18n';
import { SETTING_KEYS, SETTINGS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  codeDefaults,
  controlOf,
  isSetHere,
  isValidSettingValue,
  ORGANIZATION_SETTING_KEYS,
  settingLabels,
} from './controls';

describe('setting controls from the registry', () => {
  it.each(SETTING_KEYS)('has a control and en/de labels for %s', (key) => {
    expect(controlOf(key), `no control for ${key}: add one in controls.ts`).not.toBeNull();
    for (const locale of LOCALES) {
      expect(dictionaries[locale][settingLabels(key).name]).toBeTruthy();
      expect(dictionaries[locale][settingLabels(key).description]).toBeTruthy();
    }
  });

  it('maps enums to selects with option labels where they exist, booleans and strings', () => {
    expect(controlOf('inventory.valuationMethod')).toEqual({
      kind: 'select',
      options: [
        {
          value: 'fifo',
          label: 'platform.settings.inventoryValuationMethod.options.fifo',
        },
        {
          value: 'weighted_average',
          label: 'platform.settings.inventoryValuationMethod.options.weightedAverage',
        },
      ],
    });
    const currency = controlOf('currency');
    expect(currency?.kind).toBe('select');
    // Currency codes are shown as they are.
    expect(currency?.kind === 'select' && currency.options.find((o) => o.value === 'EUR')).toEqual({
      value: 'EUR',
      label: null,
    });
    expect(controlOf('inventory.allowNegativeStock')).toEqual({ kind: 'boolean' });
    expect(controlOf('timezone')).toEqual({ kind: 'text' });
  });

  it('labels every option label it names in en and de', () => {
    for (const key of SETTING_KEYS) {
      const control = controlOf(key);
      if (control?.kind !== 'select') continue;
      for (const option of control.options) {
        if (option.label === null) continue;
        expect(isLabelKey(option.label)).toBe(true);
        for (const locale of LOCALES) expect(dictionaries[locale][option.label]).toBeTruthy();
      }
    }
  });

  it('offers only keys that allow organization scope', () => {
    expect(ORGANIZATION_SETTING_KEYS).toEqual(
      SETTING_KEYS.filter((k) => SETTINGS[k].scopes.includes('organization')),
    );
  });

  it("checks a value against the key's own schema", () => {
    expect(isValidSettingValue('timezone', 'Europe/Vienna')).toBe(true);
    expect(isValidSettingValue('timezone', 'Mars/Olympus')).toBe(false);
    expect(isValidSettingValue('timezone', '+01:00')).toBe(false);
    expect(isValidSettingValue('inventory.allowNegativeStock', 'yes')).toBe(false);
  });

  it('falls back to the code defaults, all inherited', () => {
    const defaults = codeDefaults();
    expect(defaults.map((d) => d.key)).toEqual([...SETTING_KEYS]);
    expect(defaults.find((d) => d.key === 'currency')).toEqual({
      key: 'currency',
      value: 'EUR',
      source: 'default',
      dataBound: true,
    });
    expect(defaults.some(isSetHere)).toBe(false);
  });
});
