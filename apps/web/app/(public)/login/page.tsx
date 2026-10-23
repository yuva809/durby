'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { errorLabel } from '../../../lib/auth/errors';
import { safeNextPath } from '../../../lib/auth/next-path';
import { t } from '../../../lib/i18n';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { AuthCard, fieldClass, formText, Notice } from '../../auth-layout';
import { useAuth } from '../../providers';

/** Where to go after signing in: the guard's `next` (same-origin only) or home. */
function nextPath(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get('next'));
}

export default function LoginPage() {
  const { store, status } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(nextPath());
  }, [status, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const result = await store.login(formText(form, 'email'), formText(form, 'password'));
    setBusy(false);
    if (result.ok) router.replace(nextPath());
    else setError(t(errorLabel(result.code)));
  }

  return (
    <AuthCard title={t('auth.login.title')}>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label className={fieldClass}>
          {t('auth.login.email')}
          <Input name="email" type="email" autoComplete="username" required />
        </label>
        <label className={fieldClass}>
          {t('auth.login.password')}
          <Input name="password" type="password" autoComplete="current-password" required />
        </label>
        <Notice text={error} tone="error" />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>
      <p>
        <Link href="/forgot-password">{t('auth.login.forgotPassword')}</Link>
      </p>
    </AuthCard>
  );
}
