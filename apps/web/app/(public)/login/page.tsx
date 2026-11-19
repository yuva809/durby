'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { errorLabel } from '../../../lib/auth/errors';
import { safeNextPath } from '../../../lib/auth/next-path';
import { t } from '../../../lib/i18n';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { PasswordInput } from '../../../components/ui/password-input';
import { AuthCard, fieldClass, formText, Notice } from '../../auth-layout';
import { useAccounts, useAuth } from '../../providers';

/** Names of the password fields' show/hide button. */
const passwordLabels = { show: t('auth.password.show'), hide: t('auth.password.hide') };

/** Where to go after signing in: the guard's `next` (same-origin only) or home. */
function nextPath(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get('next'));
}

export default function LoginPage() {
  // The query comes from the router (useSearchParams needs a Suspense boundary).
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const { store, status } = useAuth();
  const accounts = useAccounts();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `?add=1`: a signed-in person adds another account (ADR 0047); the current one stays signed in. Read from the
  // route, not window.location: after the menu's navigation the address can still be the old one, and the page
  // then sent the person straight back (item 15).
  const adding = useSearchParams().get('add') === '1';

  useEffect(() => {
    if (status === 'authenticated' && !adding) router.replace(nextPath());
  }, [status, router, adding]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const email = formText(form, 'email');
    const slot = adding ? accounts.slotFor(email) : undefined;
    if (slot === null) {
      setBusy(false);
      setError(t('auth.login.accountsFull'));
      return;
    }
    const result = await store.login(email, formText(form, 'password'), slot);
    setBusy(false);
    if (result.ok) router.replace(adding ? '/' : nextPath());
    else setError(t(errorLabel(result.code)));
  }

  return (
    <AuthCard
      title={adding ? t('auth.login.addTitle') : t('auth.login.title')}
      description={adding ? t('auth.login.addSubtitle') : t('auth.login.subtitle')}
    >
      <form onSubmit={(e) => void onSubmit(e)}>
        <label className={fieldClass}>
          {t('auth.login.email')}
          <Input
            name="email"
            type="email"
            autoComplete="username"
            placeholder={t('auth.login.emailPlaceholder')}
            required
          />
        </label>
        <div className={fieldClass}>
          <span className="flex items-baseline justify-between gap-2">
            <label htmlFor="login-password">{t('auth.login.password')}</label>
            <Link href="/forgot-password" className="text-sm font-normal">
              {t('auth.login.forgotPassword')}
            </Link>
          </span>
          <PasswordInput
            labels={passwordLabels}
            id="login-password"
            name="password"
            autoComplete="current-password"
            required
          />
        </div>
        <Notice text={error} tone="error" />
        <Button
          type="submit"
          className="mt-1 min-h-12 w-full text-base font-semibold"
          disabled={busy}
        >
          {busy ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
        {adding && status === 'authenticated' && (
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full"
            onClick={() => router.replace('/')}
            data-testid="add-account-cancel"
          >
            {t('auth.login.addCancel')}
          </Button>
        )}
      </form>
    </AuthCard>
  );
}
