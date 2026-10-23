'use client';

import { useT } from '../labels-provider';
import { useAuth } from '../providers';

/** Signed-in home: a placeholder overview until the module dashboards exist. */
export default function HomePage() {
  const { session } = useAuth();
  const t = useT();
  const organization = session?.organizations.find((o) => o.id === session.activeOrganizationId);

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
