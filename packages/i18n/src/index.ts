import de from './de.json';
import en from './en.json';

/** Label keys (`module.area.item`); `en` is the source of truth for the key set. */
export type LabelKey = keyof typeof en;

export type Dictionary = Record<LabelKey, string>;

export const LOCALES = ['en', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Default label dictionaries. Scoped overrides are resolved by the API (step 1.7). */
export const dictionaries: Record<Locale, Dictionary> = { en, de };

export type Translator = (key: LabelKey) => string;

/**
 * Builds a t() for one locale. Lookup order: overrides → locale dictionary → `en` → the key itself.
 */
export function createTranslator(
  locale: Locale,
  overrides: Partial<Record<LabelKey, string>> = {},
): Translator {
  const dictionary = dictionaries[locale];
  return (key) => overrides[key] ?? dictionary[key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
}
