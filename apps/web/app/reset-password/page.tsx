'use client';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@durby/shared';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { errorLabel } from '../../lib/auth/errors';
import { useLinkToken } from '../../lib/auth/link-token';
import { postPublic } from '../../lib/auth/public-requests';
import { t } from '../../lib/i18n';
import { AuthCard, fieldStyle, formText, Notice } from '../auth-layout';

export default function ResetPasswordPage() {
  // undefined: not read yet; null: missing or malformed.
  const token = useLinkToken();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = formText(form, 'password');
    if (password !== formText(form, 'confirm')) {
      setError(t('auth.reset.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await postPublic('/password/reset', { token, password });
    setBusy(false);
    if (result.ok) setDone(true);
    else setError(t(errorLabel(result.code)));
  }

  let content;
  if (done) content = <Notice text={t('auth.reset.done')} tone="info" />;
  else if (token === null) content = <Notice text={t('auth.reset.missingToken')} tone="error" />;
  else if (token !== undefined) {
    content = (
      <form onSubmit={(e) => void onSubmit(e)}>
        <label style={fieldStyle}>
          {t('auth.reset.password')}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            required
          />
          <small>{t('auth.reset.hint')}</small>
        </label>
        <label style={fieldStyle}>
          {t('auth.reset.confirm')}
          <input name="confirm" type="password" autoComplete="new-password" required />
        </label>
        <Notice text={error} tone="error" />
        <button type="submit" disabled={busy}>
          {t('auth.reset.submit')}
        </button>
      </form>
    );
  }

  return (
    <AuthCard title={t('auth.reset.title')}>
      {content}
      <p>
        <Link href={token === null ? '/forgot-password' : '/login'}>
          {token === null ? t('auth.forgot.title') : t('auth.forgot.backToLogin')}
        </Link>
      </p>
    </AuthCard>
  );
}
