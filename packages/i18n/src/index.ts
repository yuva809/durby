import {
  DEFAULT_LOCALE,
  dictionaries,
  type LabelKey,
  type Locale,
  PLACEHOLDER,
} from './dictionaries';

export {
  DEFAULT_LOCALE,
  type Dictionary,
  dictionaries,
  isLabelKey,
  isLocale,
  type LabelKey,
  type Locale,
  LOCALES,
  PLACEHOLDER,
} from './dictionaries';

/** Values for `{name}` placeholders. */
export type LabelParams = Readonly<Record<string, string | number>>;

export type Translator = (key: LabelKey, params?: LabelParams) => string;

export interface TranslatorOptions {
  /** `html` escapes the template text and every param; `text` (default) escapes nothing. */
  format?: 'text' | 'html';
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/**
 * Builds a t() for one locale. Lookup order: overrides → locale dictionary → `en` → the key itself.
 * `overrides` must be the merged overrides of this same locale: an override is never used for
 * another locale. Params replace every `{name}` in one pass (a param's value is never expanded);
 * placeholders without a param stay as they are.
 */
export function createTranslator(
  locale: Locale,
  overrides: Partial<Record<LabelKey, string>> = {},
  options: TranslatorOptions = {},
): Translator {
  const dictionary = dictionaries[locale];
  const html = options.format === 'html';
  const escape = html ? escapeHtml : (text: string) => text;
  return (key, params) => {
    const text = overrides[key] ?? dictionary[key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
    return escape(text).replace(PLACEHOLDER, (match, name: string) =>
      params && Object.hasOwn(params, name) ? escape(String(params[name])) : match,
    );
  };
}

export {
  isOrgOverridable,
  LABEL_OVERRIDE_LIMITS,
  type LabelOverrideLevel,
  NEVER_ORG_OVERRIDABLE,
  ORG_OVERRIDABLE,
  type OverrideCheck,
  type OverrideProblem,
  placeholdersOf,
  validateOverride,
} from './overrides';
