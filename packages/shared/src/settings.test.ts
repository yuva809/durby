import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CURRENCY_CODES } from './currencies';
import {
  isSettingKey,
  SETTING_KEY_PATTERN,
  SETTING_KEYS,
  SETTINGS,
  type SettingDefinition,
  settingAllowsScope,
  settingLabelBase,
  settingRegistryProblems,
} from './settings';

const def = (overrides: Partial<SettingDefinition> = {}, key = 'x'): SettingDefinition => ({
  label: `${settingLabelBase(key)}.name`,
  description: `${settingLabelBase(key)}.description`,
  schema: z.boolean(),
  default: false,
  scopes: ['organization'],
  dataBound: false,
  ...overrides,
});

describe('settings registry', () => {
  it('has no problems', () => {
    expect(settingRegistryProblems(SETTINGS)).toEqual([]);
  });

  it('starts with the phase 1 keys', () => {
    expect(SETTING_KEYS).toEqual([
      'locale',
      'currency',
      'timezone',
      'country',
      'openingHours',
      'closedDates',
      'reservations.serviceHours',
      'reservations.slotIntervalMinutes',
      'reservations.turnTimes',
      'reservations.maxCoversPerSlot',
      'reservations.lastBookingOffsetMinutes',
      'reservations.online.instantMaxParty',
      'reservations.orderMatchWindowMinutes',
      'reservations.floorHorizonMinutes',
      'reservations.autoConfirm',
      'reservations.holdMinutes',
      'pos.billHeader',
      'pos.billFooter',
      'pos.billText',
      'pos.ticketText',
      'pos.printers',
      'pos.printJobMaxAgeSeconds',
      'pos.kitchenProcessing',
      'pos.barProcessing',
      'inventory.valuationMethod',
      'inventory.targetFoodCostPercent',
      'inventory.allowNegativeStock',
      'team.adminsManageSignIn',
      'orders.requestsNeedApproval',
      'orders.branchStores',
      'orders.showSalesOrders',
      'reports.dayStartsAt',
      'startPage',
    ]);
  });

  it('recognizes registered keys only', () => {
    expect(isSettingKey('inventory.valuationMethod')).toBe(true);
    expect(isSettingKey('inventory.everything')).toBe(false);
    expect(isSettingKey('toString')).toBe(false);
  });

  it('derives label keys from the key', () => {
    expect(settingLabelBase('inventory.valuationMethod')).toBe(
      'platform.settings.inventoryValuationMethod',
    );
    expect(SETTINGS.locale.label).toBe('platform.settings.locale.name');
  });

  it('marks currency and valuation method as data-bound, at organization scope or wider', () => {
    const bound = SETTING_KEYS.filter((key) => SETTINGS[key].dataBound);
    expect(bound).toEqual(['currency', 'inventory.valuationMethod']);
    for (const key of bound) {
      expect(settingAllowsScope(key, 'organization')).toBe(true);
      expect(settingAllowsScope(key, 'location')).toBe(false);
    }
    expect(settingAllowsScope('locale', 'location')).toBe(true);
  });
});

describe('setting values', () => {
  it('accepts supported locales only', () => {
    expect(SETTINGS.locale.schema.safeParse('de').success).toBe(true);
    expect(SETTINGS.locale.schema.safeParse('fr').success).toBe(false);
    expect(SETTINGS.locale.schema.safeParse('DE').success).toBe(false);
  });

  it('accepts active ISO 4217 codes only', () => {
    expect(SETTINGS.currency.schema.safeParse('EUR').success).toBe(true);
    expect(SETTINGS.currency.schema.safeParse('CHF').success).toBe(true);
    expect(SETTINGS.currency.schema.safeParse('eur').success).toBe(false);
    expect(SETTINGS.currency.schema.safeParse('ABC').success).toBe(false);
    expect(SETTINGS.currency.schema.safeParse('HRK').success).toBe(false);
    expect(SETTINGS.currency.schema.safeParse('XTS').success).toBe(false);
    for (const code of CURRENCY_CODES) expect(code).toMatch(/^[A-Z]{3}$/);
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });

  it('accepts IANA time zones only', () => {
    const tz = SETTINGS.timezone.schema;
    for (const ok of ['Europe/Berlin', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+1']) {
      expect(tz.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['Europe/Atlantis', '+01:00', 'berlin', '', 'Europe/Berlin '])
      expect(tz.safeParse(bad).success, bad).toBe(false);
  });

  it('accepts the valuation methods and booleans', () => {
    expect(SETTINGS['inventory.valuationMethod'].schema.safeParse('fifo').success).toBe(true);
    expect(SETTINGS['inventory.valuationMethod'].schema.safeParse('lifo').success).toBe(false);
    expect(SETTINGS['inventory.allowNegativeStock'].schema.safeParse('true').success).toBe(false);
  });
});

describe('settingRegistryProblems', () => {
  it('reports bad keys, labels, defaults and secret-looking names', () => {
    expect(
      settingRegistryProblems({
        'Bad-Key': def({}, 'Bad-Key'),
        wrongLabel: def({ label: 'x.y' }, 'wrongLabel'),
        badDefault: def({ default: 'yes' }, 'badDefault'),
        'payments.apiKey': def({}, 'payments.apiKey'),
      }),
    ).toEqual([
      `Bad-Key: key must match ${SETTING_KEY_PATTERN}`,
      'wrongLabel: labels must be platform.settings.wrongLabel.name and platform.settings.wrongLabel.description',
      'badDefault: default fails the schema',
      'payments.apiKey: settings never hold secrets',
    ]);
  });

  it('reports loose object schemas and bad scopes', () => {
    expect(
      settingRegistryProblems({
        loose: def({ schema: z.object({ a: z.number() }), default: { a: 1 } }, 'loose'),
        none: def({ scopes: [] }, 'none'),
        bound: def({ scopes: ['organization', 'location'], dataBound: true }, 'bound'),
      }),
    ).toEqual([
      'loose: object schema must be strict',
      'none: needs at least one scope',
      'bound: data-bound settings start at organization scope',
    ]);
  });

  it('reports a read schema that reads the default differently from the schema', () => {
    const schema = z.strictObject({ a: z.number() });
    expect(
      settingRegistryProblems({
        lenient: def(
          { schema, read: z.preprocess((v) => v, schema), default: { a: 1 } },
          'lenient',
        ),
        wrong: def({ schema, read: z.strictObject({ b: z.number() }), default: { a: 1 } }, 'wrong'),
      }),
    ).toEqual(['wrong: the read schema must read the default as the schema does']);
  });
});
