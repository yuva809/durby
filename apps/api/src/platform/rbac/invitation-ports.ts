import type { Locale, Translator } from '@durby/i18n';

/**
 * What invitations need from labels and settings, declared here and provided by those folders
 * (like ACTIVE_ACCESS_LOOKUP): labels and settings use rbac's route markers and access checks, so
 * rbac importing them would be an import cycle (docs/reviews/phase-1.md → R2).
 */

/** The current organization's labels in `locale` (LabelService provides it). */
export const INVITATION_LABELS = Symbol('INVITATION_LABELS');

export interface InvitationLabels {
  translator(locale: Locale): Promise<Translator>;
}

/** The current organization's resolved `locale` setting (SettingsService provides it). */
export const INVITATION_SETTINGS = Symbol('INVITATION_SETTINGS');

export interface InvitationSettings {
  get(key: 'locale'): Promise<string>;
}
