'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { PasswordInput } from '../../../components/ui/password-input';
import { useStaffSession } from '../../../components/staff/staff-session';
import { TwoFactorStep } from '../../../components/staff/two-factor-step';
import { errorLabel } from '../../../lib/auth/errors';
import { t } from '../../../lib/i18n';
import { staffApi } from '../../../lib/staff/api';
import { AuthCard, fieldClass, formText, Notice } from '../../auth-layout';

const passwordLabels = { show: t('auth.password.show'), hide: t('auth.password.hide') };

/** /platform/login: password, then a code from the authenticator (or its setup after a reset). */
export default function StaffLoginPage() {
  const { session, reload } = useStaffSession();
  const router = useRouter();
  const [next, setNext] = useState<'totp' | 'enroll' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session.status === 'signedIn') router.replace('/platform');
  }, [session.status, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const result = await staffApi.login(formText(form, 'email'), formText(form, 'password'));
    setBusy(false);
    if (result.ok) setNext(result.data.next);
    else setError(t(errorLabel(result.code)));
  }

  if (next) {
    return (
      <AuthCard title={next === 'enroll' ? t('staff.enroll.title') : t('staff.login.codeTitle')}>
        <TwoFactorStep mode={next} onDone={reload} />
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('staff.login.title')} description={t('staff.login.subtitle')}>
      <form onSubmit={(e) => void onSubmit(e)} data-testid="staff-login">
        <label className={fieldClass}>
          {t('staff.login.email')}
          <Input name="email" type="email" autoComplete="username" required />
        </label>
        <div className={fieldClass}>
          <label htmlFor="staff-password">{t('staff.login.password')}</label>
          <PasswordInput
            labels={passwordLabels}
            id="staff-password"
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
          {t('staff.login.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
