'use client';

import type { StaffEnrollResponse } from '@durby/shared';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { fieldClass, formText, Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffApi, type StaffResult } from '../../lib/staff/api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/** The 6-digit field: numeric keyboard on phones, autofill from password managers. */
export function CodeInput({ id }: { id: string }) {
  return (
    <Input
      id={id}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]{6,7}"
      maxLength={7}
      required
      className="text-center font-mono text-lg tracking-[0.3em]"
      data-testid="staff-code"
    />
  );
}

/**
 * After the password: enter a code (`totp`), or set up the authenticator first (`enroll`: QR code
 * and key, then a code to confirm). `onDone` runs once the session is active.
 */
export function TwoFactorStep({
  mode,
  onDone,
}: {
  mode: 'totp' | 'enroll';
  onDone: () => void | Promise<void>;
}) {
  const [enrollment, setEnrollment] = useState<StaffEnrollResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'enroll') return;
    let current = true;
    void staffApi.enroll().then(async (result) => {
      if (!current) return;
      if (!result.ok) {
        setError(t(errorLabel(result.code)));
        return;
      }
      setEnrollment(result.data);
      // A data URL image: rendered locally, the secret never leaves the browser for a QR service.
      const url = await QRCode.toDataURL(result.data.otpauthUri, { margin: 1, width: 192 });
      if (current) setQr(url);
    });
    return () => {
      current = false;
    };
  }, [mode]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = formText(new FormData(event.currentTarget), 'code');
    setBusy(true);
    setError(null);
    const result: StaffResult<null> =
      mode === 'enroll' ? await staffApi.confirmEnrollment(code) : await staffApi.verifyCode(code);
    setBusy(false);
    if (result.ok) await onDone();
    else setError(t(errorLabel(result.code)));
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} data-testid={`staff-${mode}-step`}>
      {mode === 'enroll' ? (
        <div className="mb-5 flex flex-col gap-3 text-sm">
          <p>{t('staff.enroll.scan')}</p>
          <div className="flex justify-center">
            {qr ? (
              // A generated data URL: next/image adds nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt={t('staff.enroll.qrAlt')}
                width={192}
                height={192}
                className="rounded-lg border bg-card p-2"
              />
            ) : (
              <div className="size-48 animate-pulse rounded-lg bg-muted" aria-hidden />
            )}
          </div>
          {enrollment && (
            <p className="text-muted-foreground">
              {t('staff.enroll.manual')}{' '}
              <code
                className="font-mono break-all text-foreground select-all"
                data-testid="staff-secret"
              >
                {enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
            </p>
          )}
        </div>
      ) : (
        <p className="mb-5 text-sm text-muted-foreground">{t('staff.login.codeHint')}</p>
      )}
      <div className={fieldClass}>
        <label htmlFor="staff-code">{t('staff.login.code')}</label>
        <CodeInput id="staff-code" />
      </div>
      <Notice text={error} tone="error" />
      <Button
        type="submit"
        className="mt-1 min-h-12 w-full text-base font-semibold"
        disabled={busy}
      >
        {mode === 'enroll' ? t('staff.enroll.confirm') : t('staff.login.verify')}
      </Button>
    </form>
  );
}
