'use client';

import { PASSWORD_MIN_LENGTH } from '@durby/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { PasswordInput } from '../../../components/ui/password-input';
import { useStaffSession } from '../../../components/staff/staff-session';
import { TwoFactorStep } from '../../../components/staff/two-factor-step';
import { useLinkToken } from '../../../lib/auth/link-token';
import { errorLabel } from '../../../lib/auth/errors';
import { t } from '../../../lib/i18n';
import { staffApi } from '../../../lib/staff/api';
import { AuthCard, fieldClass, formText, Notice } from '../../auth-layout';

const passwordLabels = { show: t('auth.password.show'), hide: t('auth.password.hide') };

/** /platform/accept#token=…: set a password, then set up two-factor authentication. */
export default function StaffAcceptPage() {
  const { reload } = useStaffSession();
  const router = useRouter();
  // From the link's fragment, which browsers never send to a server; removed from the URL once read.
  const token = useLinkToken();
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const result = await staffApi.accept(
      token,
      formText(new FormData(event.currentTarget), 'password'),
    );
    setBusy(false);
    if (result.ok) setEnrolling(true);
    else setError(t(errorLabel(result.code)));
  }

  if (enrolling) {
    return (
      <AuthCard title={t('staff.enroll.title')}>
        <TwoFactorStep
          mode="enroll"
          onDone={async () => {
            await reload();
            router.replace('/platform');
          }}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('staff.accept.title')}>
      {token === null ? (
        <Notice text={t('staff.accept.missingToken')} tone="error" />
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} data-testid="staff-accept">
          <div className={fieldClass}>
            <label htmlFor="staff-new-password">{t('staff.login.password')}</label>
            <PasswordInput
              labels={passwordLabels}
              id="staff-new-password"
              name="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
            <span className="text-xs font-normal text-muted-foreground">
              {t('staff.accept.passwordHint')}
            </span>
          </div>
          <Notice text={error} tone="error" />
          <Button
            type="submit"
            className="mt-1 min-h-12 w-full text-base font-semibold"
            disabled={busy || token === undefined}
          >
            {t('staff.accept.submit')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
