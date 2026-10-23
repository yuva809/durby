'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { errorLabel } from '../lib/auth/errors';
import { roleName } from '../lib/rbac/roles';
import { Notice } from './auth-layout';
import { useT } from './labels-provider';
import { useAuth } from './providers';

/** Signed-in user, organization switcher and sign-out. Sends anonymous visitors to /login. */
export function AccountPanel() {
  const { store, session, status } = useAuth();
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (!session) return <p>{t('auth.session.loading')}</p>;

  async function switchTo(organizationId: string) {
    setError(null);
    const result = await store.switchOrganization(organizationId);
    if (!result.ok) setError(t(errorLabel(result.code)));
  }

  return (
    <section>
      <p>
        {t('auth.session.signedInAs')}{' '}
        <strong data-testid="user-email">{session.user.email}</strong> ·{' '}
        <Link href="/logout">{t('auth.logout.action')}</Link>
      </p>
      {session.organizations.length === 0 ? (
        <p>{t('auth.session.noOrganization')}</p>
      ) : (
        <label>
          {t('auth.session.organization')}{' '}
          <select
            data-testid="organization"
            value={session.activeOrganizationId ?? ''}
            onChange={(e) => void switchTo(e.target.value)}
          >
            {session.organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {session.activeRole && (
        <p>
          {t('auth.session.role')}:{' '}
          <strong data-testid="role">{roleName(session.activeRole, t)}</strong>
        </p>
      )}
      <Notice text={error} tone="error" />
    </section>
  );
}
