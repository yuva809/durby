/// <reference types="node" />
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { labelFiles as deFiles } from './de';
import { labelFiles as enFiles } from './en';
import { createTranslator, dictionaries, LOCALES, placeholdersOf } from './index';

const FILES: Record<(typeof LOCALES)[number], Record<string, Record<string, string>>> = {
  en: enFiles,
  de: deFiles,
};

/** ADR 0022: one file per key prefix and locale, merged into `dictionaries`. */
describe('label files', () => {
  it.each(LOCALES)('%s: every key is in the file of its first segment', (locale) => {
    const misplaced = Object.entries(FILES[locale]).flatMap(([file, labels]) =>
      Object.keys(labels)
        .filter((key) => key.split('.')[0] !== file)
        .map(
          (key) =>
            `${key} is in ${locale}/${file}.json, belongs in ${locale}/${key.split('.')[0]}.json`,
        ),
    );
    expect(misplaced).toEqual([]);
  });

  it.each(LOCALES)('%s: imports every file of src/%s, and only those', (locale) => {
    const onDisk = readdirSync(join(import.meta.dirname, locale))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(Object.keys(FILES[locale]).sort()).toEqual(onDisk);
  });

  it.each(LOCALES)('%s: no key is in two files', (locale) => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const [file, labels] of Object.entries(FILES[locale])) {
      for (const key of Object.keys(labels)) {
        if (seen.has(key)) twice.push(`${key}: ${seen.get(key)}.json and ${file}.json`);
        seen.set(key, file);
      }
    }
    expect(twice).toEqual([]);
    expect(Object.keys(dictionaries[locale])).toHaveLength(seen.size);
  });

  it.each(LOCALES)(
    '%s has the files of en, each with the same keys in the same order',
    (locale) => {
      expect(Object.keys(FILES[locale]).sort()).toEqual(Object.keys(FILES.en).sort());
      for (const [file, labels] of Object.entries(FILES.en)) {
        expect([file, Object.keys(FILES[locale][file] ?? {})]).toEqual([file, Object.keys(labels)]);
      }
    },
  );
});

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

  it.each(LOCALES)('%s keeps the placeholders of en for every key', (locale) => {
    for (const [key, text] of Object.entries(dictionaries.en)) {
      const translated = dictionaries[locale][key as keyof typeof dictionaries.en];
      expect([key, placeholdersOf(translated)]).toEqual([key, placeholdersOf(text)]);
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

  it('replaces every occurrence of a placeholder and leaves unknown ones', () => {
    const t = createTranslator('en', {
      'platform.email.invite.subject': '{organization} invites you to {organization} ({x})',
    });
    expect(t('platform.email.invite.subject', { organization: 'Acme' })).toBe(
      'Acme invites you to Acme ({x})',
    );
  });

  it('never expands placeholders inside a param value', () => {
    const t = createTranslator('en', { 'platform.email.invite.subject': '{organization} {link}' });
    expect(t('platform.email.invite.subject', { organization: '{link}', link: 'L' })).toBe(
      '{link} L',
    );
  });

  it('escapes the template and every param in html format, and nothing in text format', () => {
    const overrides = { 'platform.email.invite.subject': '<b>{organization}</b> & co' };
    const html = createTranslator('en', overrides, { format: 'html' });
    expect(html('platform.email.invite.subject', { organization: `"A'<i>"` })).toBe(
      '&lt;b&gt;&quot;A&#39;&lt;i&gt;&quot;&lt;/b&gt; &amp; co',
    );
    const text = createTranslator('en', overrides);
    expect(text('platform.email.invite.subject', { organization: '<i>' })).toBe('<b><i></b> & co');
  });
});
