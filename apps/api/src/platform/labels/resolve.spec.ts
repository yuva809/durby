import { dictionaries } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import { type LabelRows, resolveDictionary, type SkippedOverride } from './resolve';

const NAV = 'inventory.nav.title';
const rows = (r: Partial<LabelRows>): LabelRows => ({ partner: [], organization: [], ...r });

describe('resolveDictionary', () => {
  it('returns the defaults of the locale without overrides', () => {
    expect(resolveDictionary(rows({}), 'de')).toEqual(dictionaries.de);
    expect(resolveDictionary(rows({}), 'en')[NAV]).toBe('Inventory');
  });

  it('prefers organization over partner over default', () => {
    const partner = [{ locale: 'en', key: NAV, value: 'Stock' }];
    expect(resolveDictionary(rows({ partner }), 'en')[NAV]).toBe('Stock');
    const organization = [{ locale: 'en', key: NAV, value: 'Products' }];
    expect(resolveDictionary(rows({ partner, organization }), 'en')[NAV]).toBe('Products');
  });

  it('never uses an override of another locale', () => {
    const organization = [{ locale: 'en', key: NAV, value: 'Products' }];
    expect(resolveDictionary(rows({ organization }), 'de')[NAV]).toBe('Lager');
    const partner = [{ locale: 'de', key: NAV, value: 'Bestand' }];
    expect(resolveDictionary(rows({ partner, organization }), 'de')[NAV]).toBe('Bestand');
    expect(resolveDictionary(rows({ partner, organization }), 'en')[NAV]).toBe('Products');
  });

  it('falls back to the en default for a key missing in a locale', () => {
    const original = dictionaries.de[NAV];
    try {
      delete (dictionaries.de as Partial<Record<string, string>>)[NAV];
      expect(resolveDictionary(rows({}), 'de')[NAV]).toBe('Inventory');
    } finally {
      dictionaries.de[NAV] = original;
    }
  });

  it('lets partners override any key, organizations only terminology', () => {
    const skipped: SkippedOverride[] = [];
    const partner = [{ locale: 'en', key: 'platform.app.name', value: 'Acme' }];
    const organization = [
      { locale: 'en', key: 'platform.app.name', value: 'Phish' },
      { locale: 'en', key: 'platform.email.invite.subject', value: 'Win {organization}' },
    ];
    const resolved = resolveDictionary(rows({ partner, organization }), 'en', (s) =>
      skipped.push(s),
    );
    expect(resolved['platform.app.name']).toBe('Acme');
    expect(resolved['platform.email.invite.subject']).toBe(
      dictionaries.en['platform.email.invite.subject'],
    );
    expect(skipped.map((s) => [s.level, s.key, s.reason])).toEqual([
      ['organization', 'platform.app.name', 'not_overridable'],
      ['organization', 'platform.email.invite.subject', 'not_overridable'],
    ]);
  });

  it('skips and reports stored rows that are no longer valid; the next level applies', () => {
    const skipped: SkippedOverride[] = [];
    const resolved = resolveDictionary(
      rows({
        partner: [
          { locale: 'en', key: NAV, value: 'Stock' },
          { locale: 'en', key: 'platform.email.invite.subject', value: 'Join now' },
          { locale: 'en', key: 'gone.nav.title', value: 'Old' },
        ],
        organization: [
          { locale: 'en', key: NAV, value: 'x'.repeat(201) },
          { locale: 'en', key: 'platform.nav.label', value: 'Menu {x}' },
        ],
      }),
      'en',
      (s) => skipped.push(s),
    );
    expect(resolved[NAV]).toBe('Stock');
    expect(resolved['platform.nav.label']).toBe('Main navigation');
    expect(resolved['platform.email.invite.subject']).toBe("You're invited to {organization}");
    expect(skipped).toEqual([
      {
        level: 'partner',
        locale: 'en',
        key: 'platform.email.invite.subject',
        reason: 'placeholders',
      },
      { level: 'partner', locale: 'en', key: 'gone.nav.title', reason: 'unknown_key' },
      { level: 'organization', locale: 'en', key: NAV, reason: 'too_long' },
      { level: 'organization', locale: 'en', key: 'platform.nav.label', reason: 'placeholders' },
    ]);
  });
});
