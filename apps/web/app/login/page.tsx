'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { AuthCard, fieldStyle, formText, Notice } from '../auth-layout';
import { useAuth } from '../providers';

export default function LoginPage() {
  const { store, status } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const result = await store.login(formText(form, 'email'), formText(form, 'password'));
    setBusy(false);
    if (result.ok) router.replace('/');
    else setError(t(errorLabel(result.code)));
  }

  return (
    <AuthCard title={t('auth.login.title')}>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label style={fieldStyle}>
          {t('auth.login.email')}
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label style={fieldStyle}>
          {t('auth.login.password')}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <Notice text={error} tone="error" />
        <button type="submit" disabled={busy}>
          {busy ? t('auth.login.submitting') : t('auth.login.submit')}
        </button>
      </form>
      <p>
        <Link href="/forgot-password">{t('auth.login.forgotPassword')}</Link>
      </p>
    </AuthCard>
  );
}
