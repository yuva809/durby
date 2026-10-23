'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { t } from '../../../lib/i18n';
import { AuthCard } from '../../auth-layout';
import { useAuth } from '../../providers';

/** Ends the session on the server (refresh family revoked) and drops the in-memory token. */
export default function LogoutPage() {
  const { store } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Logout is idempotent, so a repeated effect (dev strict mode) is harmless.
    void store
      .logout()
      .catch(() => undefined)
      .finally(() => router.replace('/login'));
  }, [store, router]);

  return <AuthCard title={t('auth.logout.inProgress')}>{null}</AuthCard>;
}
