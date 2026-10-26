import { DEFAULT_LOCALE, isLabelKey, isLocale, type LabelKey, type Locale } from '@durby/i18n';
import { labelsResponseSchema } from '@durby/shared';
import type { Session, SessionStore } from '../auth/session';

/** The organization's labels for the signed-in UI (docs/platform/labels.md → Web app). */

export const LABELS_API = '/api/v1/labels';

export type Labels = Partial<Record<LabelKey, string>>;

/** The user's own locale, or the default if it isn't supported. */
export function localeOf(session: Pick<Session, 'user'>): Locale {
  return isLocale(session.user.locale) ? session.user.locale : DEFAULT_LOCALE;
}

/**
 * The merged dictionary of the active organization in `locale`, or null if the call is denied
 * (e.g. a custom role without platform.settings.read) or fails: callers use the bundled defaults.
 */
export async function fetchLabels(store: SessionStore, locale: Locale): Promise<Labels | null> {
  try {
    const res = await store.apiFetch(`${LABELS_API}?locale=${locale}`);
    if (!res.ok) return null;
    const parsed = labelsResponseSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.locale !== locale) return null;
    const labels: Labels = {};
    for (const [key, text] of Object.entries(parsed.data.data)) {
      if (isLabelKey(key)) labels[key] = text;
    }
    return labels;
  } catch {
    return null;
  }
}

export interface LabelsCache {
  /** One request per user, organization and locale; a failed load is retried next time. */
  get: (userId: string, organizationId: string, locale: Locale) => Promise<Labels | null>;
  /** Forgets every entry: the next get loads again (after an override changed). */
  clear: () => void;
}

export function createLabelsCache(load: (locale: Locale) => Promise<Labels | null>): LabelsCache {
  const entries = new Map<string, Promise<Labels | null>>();
  return {
    get: (userId, organizationId, locale) => {
      const key = `${userId}:${organizationId}:${locale}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = load(locale).then((labels) => {
          if (labels === null) entries.delete(key);
          return labels;
        });
        entries.set(key, entry);
      }
      return entry;
    },
    clear: () => entries.clear(),
  };
}
