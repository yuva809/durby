'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useNavLayout } from '../../components/theme-provider';
import { isBranchView, isDriverView } from '../../lib/nav/layouts';
import { useT } from '../labels-provider';
import { useAuth } from '../providers';

/**
 * Signed-in home: a placeholder overview until the module dashboards exist. A branch's menu has no Overview (ADR
 * 0059): it starts on Inventory.
 */
export default function HomePage() {
  const { session } = useAuth();
  const t = useT();
  const router = useRouter();
  const operations = useNavLayout() === 'operations' && session !== null;
  const branch = operations && isBranchView(session);
  // A driver's menu has no Overview either (item 14): they start on their deliveries.
  const driver = operations && isDriverView(session);
  useEffect(() => {
    if (branch) router.replace('/inventory');
    else if (driver) router.replace('/my-deliveries');
  }, [branch, driver, router]);
  const organization = session?.organizations.find((o) => o.id === session.activeOrganizationId);
  if (branch || driver) return null;

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
