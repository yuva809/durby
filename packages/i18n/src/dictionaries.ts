import de from './de.json';
import en from './en.json';

/** Label keys (`module.area.item`); `en` is the source of truth for the key set. */
export type LabelKey = keyof typeof en;

export type Dictionary = Record<LabelKey, string>;

export const LOCALES = ['en', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Default label dictionaries. Overrides are resolved by the API (docs/platform/labels.md). */
export const dictionaries: Record<Locale, Dictionary> = { en, de };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function isLabelKey(value: string): value is LabelKey {
  return Object.hasOwn(dictionaries[DEFAULT_LOCALE], value);
}

/** `{name}` placeholders: a letter, then letters or digits. */
export const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;
