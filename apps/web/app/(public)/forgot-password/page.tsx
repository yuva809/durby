'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { errorLabel } from '../../../lib/auth/errors';
import { postPublic } from '../../../lib/auth/public-requests';
import { t } from '../../../lib/i18n';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { AuthCard, fieldClass, formText, Notice } from '../../auth-layout';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = formText(new FormData(event.currentTarget), 'email');
    setBusy(true);
    setError(null);
    // Same answer whether or not the account exists (the api never says).
    const result = await postPublic('/password/forgot', { email });
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(t(errorLabel(result.code)));
  }

  return (
    <AuthCard title={t('auth.forgot.title')}>
      {sent ? (
        <Notice text={t('auth.forgot.sent')} tone="info" />
      ) : (
        <form onSubmit={(e) => void onSubmit(e)}>
          <p>{t('auth.forgot.intro')}</p>
          <label className={fieldClass}>
            {t('auth.login.email')}
            <Input name="email" type="email" autoComplete="username" required />
          </label>
          <Notice text={error} tone="error" />
          <Button type="submit" className="w-full" disabled={busy}>
            {t('auth.forgot.submit')}
          </Button>
        </form>
      )}
      <p>
        <Link href="/login">{t('auth.forgot.backToLogin')}</Link>
      </p>
    </AuthCard>
  );
}
