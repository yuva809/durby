'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useNavLayout } from '../../components/theme-provider';
import { isBranchView } from '../../lib/nav/layouts';
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
  const branch = useNavLayout() === 'operations' && session !== null && isBranchView(session);
  useEffect(() => {
    if (branch) router.replace('/inventory');
  }, [branch, router]);
  const organization = session?.organizations.find((o) => o.id === session.activeOrganizationId);
  if (branch) return null;

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
