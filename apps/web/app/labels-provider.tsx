'use client';

import { createTranslator, DEFAULT_LOCALE, type Translator } from '@durby/i18n';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { createLabelsCache, fetchLabels, type Labels, localeOf } from '../lib/labels/labels';
import { useAuth } from './providers';

const LabelsContext = createContext<Translator | null>(null);

/**
 * Loads the active organization's labels once per session, organization and locale (again after
 * switching organization). Until they arrive, or if the call is denied or fails, t() uses the
 * bundled defaults of the user's locale.
 */
export function LabelsProvider({ children }: { children: ReactNode }) {
  const { store, session } = useAuth();
  const [cache] = useState(() => createLabelsCache((locale) => fetchLabels(store, locale)));
  const [loaded, setLoaded] = useState<{ key: string; labels: Labels | null } | null>(null);

  const userId = session?.user.id ?? null;
  const organizationId = session?.activeOrganizationId ?? null;
  const locale = session ? localeOf(session) : DEFAULT_LOCALE;
  const key = userId && organizationId ? `${userId}:${organizationId}:${locale}` : null;

  useEffect(() => {
    if (!userId || !organizationId || !key) return;
    let current = true;
    void cache.get(userId, organizationId, locale).then((labels) => {
      if (current) setLoaded({ key, labels });
    });
    return () => {
      current = false;
    };
  }, [cache, userId, organizationId, locale, key]);

  const labels = loaded?.key === key ? loaded.labels : null;
  const t = useMemo(() => createTranslator(locale, labels ?? {}), [locale, labels]);
  return <LabelsContext value={t}>{children}</LabelsContext>;
}

/** t(key, params) with the active organization's labels. Renders as text: React escapes it. */
export function useT(): Translator {
  const t = useContext(LabelsContext);
  if (!t) throw new Error('useT needs <LabelsProvider>');
  return t;
}
