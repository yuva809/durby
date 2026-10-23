import { createTranslator, DEFAULT_LOCALE } from '@durby/i18n';

/**
 * Bundled default labels, for public pages (login, password reset, accept-invite) and server
 * components: never an organization's overrides (docs/platform/labels.md → Web app). Signed-in UI
 * uses useT() from app/labels-provider.tsx.
 */
export const t = createTranslator(DEFAULT_LOCALE);
