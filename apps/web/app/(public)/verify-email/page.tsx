'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { errorLabel } from '../../../lib/auth/errors';
import { useLinkToken } from '../../../lib/auth/link-token';
import { postPublic } from '../../../lib/auth/public-requests';
import { t } from '../../../lib/i18n';
import { AuthCard, Notice } from '../../auth-layout';

export default function VerifyEmailPage() {
  const token = useLinkToken();
  const [result, setResult] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  // The token is single-use: never send it twice (dev strict mode runs effects twice).
  const sent = useRef(false);

  useEffect(() => {
    if (typeof token !== 'string' || sent.current) return;
    sent.current = true;
    void postPublic('/verify-email', { token }).then((res) =>
      setResult(
        res.ok
          ? { text: t('auth.verify.done'), tone: 'info' }
          : { text: t(errorLabel(res.code)), tone: 'error' },
      ),
    );
  }, [token]);

  const shown =
    token === null
      ? { text: t('auth.errors.tokenInvalid'), tone: 'error' as const }
      : (result ?? { text: t('auth.verify.inProgress'), tone: 'info' as const });

  return (
    <AuthCard title={t('auth.verify.title')}>
      <Notice text={shown.text} tone={shown.tone} />
      <p>
        <Link href="/login">{t('auth.forgot.backToLogin')}</Link>
      </p>
    </AuthCard>
  );
}
