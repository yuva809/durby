'use client';

import { type FormEvent, type ReactNode, useCallback, useState } from 'react';
import { fieldClass, formText, Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffApi, type StaffResult } from '../../lib/staff/api';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog';
import { PasswordInput } from '../ui/password-input';

interface Pending {
  run: () => Promise<StaffResult<unknown>>;
  first: StaffResult<unknown>;
  resolve: (result: StaffResult<unknown>) => void;
}

const passwordLabels = { show: t('auth.password.show'), hide: t('auth.password.hide') };

/**
 * Sensitive staff actions need a password confirmation in the last 15 minutes (ADR 0017
 * §3). `guard(run)` runs the action; if the api asks for a confirmation, the dialog asks for it and
 * runs the action again. Cancelling returns the original answer.
 */
export function useReauth(onConfirmed?: () => void): {
  guard: <T>(run: () => Promise<StaffResult<T>>) => Promise<StaffResult<T>>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = useCallback(async <T,>(run: () => Promise<StaffResult<T>>) => {
    const first = await run();
    if (first.ok || first.code !== 'staff.reauth_required') return first;
    return new Promise<StaffResult<T>>((resolve) => {
      setError(null);
      setPending({
        run,
        first,
        resolve: resolve as (result: StaffResult<unknown>) => void,
      });
    });
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const confirmed = await staffApi.reauth(formText(form, 'password'));
    if (!confirmed.ok) {
      setBusy(false);
      setError(t(errorLabel(confirmed.code)));
      return;
    }
    onConfirmed?.();
    const result = await pending.run();
    setBusy(false);
    pending.resolve(result);
    setPending(null);
  }

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && pending) {
          pending.resolve(pending.first);
          setPending(null);
        }
      }}
    >
      <DialogContent closeLabel={t('platform.common.close')} data-testid="staff-reauth">
        <DialogTitle>{t('staff.reauth.title')}</DialogTitle>
        <DialogDescription>{t('staff.reauth.description')}</DialogDescription>
        <form onSubmit={(e) => void onSubmit(e)} className="mt-2">
          <div className={fieldClass}>
            <label htmlFor="staff-reauth-password">{t('staff.login.password')}</label>
            <PasswordInput
              labels={passwordLabels}
              id="staff-reauth-password"
              name="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="submit" disabled={busy} data-testid="staff-reauth-confirm">
              {t('staff.reauth.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return { guard, dialog };
}
