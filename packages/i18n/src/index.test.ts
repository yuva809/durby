import { describe, expect, it } from 'vitest';
import { createTranslator, dictionaries, LOCALES } from './index';

describe('dictionaries', () => {
  it.each(LOCALES)('%s has exactly the same keys as en', (locale) => {
    expect(Object.keys(dictionaries[locale]).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });

  it.each(LOCALES)('%s uses flat dotted keys with string values', (locale) => {
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(typeof value).toBe('string');
    }
  });
});

describe('createTranslator', () => {
  it('resolves a key in the requested locale', () => {
    expect(createTranslator('de')('platform.health.status.unavailable')).toBe('Nicht erreichbar');
  });

  it('prefers overrides over the dictionary', () => {
    const t = createTranslator('en', { 'platform.home.title': 'Products' });
    expect(t('platform.home.title')).toBe('Products');
  });

  it('falls back to en, then to the key itself', () => {
    const original = dictionaries.de['platform.home.title'];
    try {
      delete (dictionaries.de as Partial<Record<string, string>>)['platform.home.title'];
      expect(createTranslator('de')('platform.home.title')).toBe(
        dictionaries.en['platform.home.title'],
      );

      const t = createTranslator('de');
      expect(t('missing.key' as never)).toBe('missing.key');
    } finally {
      dictionaries.de['platform.home.title'] = original;
    }
  });
});
