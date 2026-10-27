'use client';

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useAuth } from '../../app/providers';
import { type MoneyFormat, moneyFormat } from '../../lib/pos/format';
import { loadSettings } from '../../lib/settings/api';
import { useResource } from '../../lib/use-resource';

const MoneyContext = createContext<MoneyFormat>((amount) => amount);

/**
 * Formats amounts on the POS screens in the organization's currency and locale (settings
 * `currency`, `locale`; every POS role holds `platform.settings.read`). Until the settings load, or
 * if they can't, amounts show as plain decimal strings.
 */
export function MoneyProvider({ children }: { children: ReactNode }) {
  const { store, session } = useAuth();
  const [settings] = useResource(session?.activeOrganizationId ?? null, () => loadSettings(store));
  const format = useMemo<MoneyFormat>(() => {
    if (settings.status !== 'ready') return (amount) => amount;
    const value = (key: string) => settings.data.find((s) => s.key === key)?.value;
    const currency = value('currency');
    const locale = value('locale');
    return typeof currency === 'string'
      ? moneyFormat(typeof locale === 'string' ? locale : 'en', currency)
      : (amount) => amount;
  }, [settings]);
  return <MoneyContext.Provider value={format}>{children}</MoneyContext.Provider>;
}

export function useMoney(): MoneyFormat {
  return useContext(MoneyContext);
}
