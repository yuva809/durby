'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { SETTINGS } from '@durby/shared';
import { Overview, overviewVisible } from '../../components/reports/overview';
import { useNavLayout } from '../../components/theme-provider';
import { isBranchView, isDriverView } from '../../lib/nav/layouts';
import { loadSettings } from '../../lib/settings/api';
import { useResource } from '../../lib/use-resource';
import { useT } from '../labels-provider';
import { useAuth } from '../providers';

/**
 * Signed-in home: the owner overview (ADR 0082) for those who may read sales reports, a greeting for everyone else. A
 * branch's menu has no Overview (ADR 0059): it starts on Inventory.
 */
export default function HomePage() {
  const { session, store } = useAuth();
  const t = useT();
  const router = useRouter();
  // The organization's start page (ADR 0075): Inventory instead of Overview.
  const [settings] = useResource(session?.activeOrganizationId ?? null, () => loadSettings(store));
  const inventoryStart =
    settings.status === 'ready' &&
    settings.data.some((s) => s.key === 'startPage' && s.value === 'inventory');
  const operations = useNavLayout() === 'operations' && session !== null;
  const branch = operations && isBranchView(session);
  // A driver's menu has no Overview either (item 14): they start on their deliveries.
  const driver = operations && isDriverView(session);
  // The waiter app (ADR 0072): opened from the home screen, people who take orders start at Service.
  const till =
    session !== null &&
    settings.status !== 'loading' &&
    !overviewVisible(session) &&
    session.activeFeatures.includes('pos') &&
    session.activePermissions.includes('pos.orders.read');
  useEffect(() => {
    if (driver) router.replace('/my-deliveries');
    else if (branch || inventoryStart) router.replace('/inventory');
    else if (till && window.matchMedia?.('(display-mode: standalone)').matches) {
      router.replace('/service');
    }
  }, [branch, driver, inventoryStart, router, till]);
  const organization = session?.organizations.find((o) => o.id === session.activeOrganizationId);
  if (branch || driver || inventoryStart) return null;
  if (session?.activeOrganizationId && overviewVisible(session)) {
    // Until the settings are here, the start page may still lead elsewhere.
    if (settings.status === 'loading') return null;
    const setting = (key: 'locale' | 'timezone'): string => {
      const value =
        settings.status === 'ready' ? settings.data.find((s) => s.key === key)?.value : undefined;
      return typeof value === 'string' ? value : SETTINGS[key].default;
    };
    return <Overview session={session} locale={setting('locale')} timeZone={setting('timezone')} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold">{t('platform.home.title')}</h1>
      {organization ? (
        <p className="text-muted-foreground">
          {t('platform.home.welcome', { organization: organization.name })}
        </p>
      ) : (
        <p className="text-muted-foreground">{t('auth.session.noOrganization')}</p>
      )}
    </div>
  );
}
