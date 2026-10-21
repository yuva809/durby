import { createTranslator, DEFAULT_LOCALE } from '@durby/i18n';

// Default dictionary only; per-session locale and scoped overrides arrive in step 1.7.
export const t = createTranslator(DEFAULT_LOCALE);
