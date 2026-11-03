'use client';

import { PASSWORD_MIN_LENGTH } from '@durby/shared';
import { KeyRound } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Label } from '../ui/label';
import { PasswordInput } from '../ui/password-input';

/**
 * Shown instead of the app while the session's password is a temporary one an organization set
 * (ADR 0023 §3). The api allows nothing else until it is changed; the new session replaces this.
 */
export function ChoosePassword() {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = { show: t('auth.password.show'), hide: t('auth.password.hide') };

  async function submit() {
    setProblem(null);
    if (next.length < PASSWORD_MIN_LENGTH) {
      return setProblem(t('auth.changePassword.tooShort', { min: String(PASSWORD_MIN_LENGTH) }));
    }
    if (next !== repeat) return setProblem(t('auth.changePassword.mismatch'));
    if (next === current) return setProblem(t('auth.changePassword.same'));
    setBusy(true);
    const result = await store.changePassword(current, next);
    setBusy(false);
    if (!result.ok) setProblem(t(errorLabel(result.code)));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="flex w-full max-w-md flex-col gap-5 p-6" data-testid="choose-password">
        <div className="flex flex-col items-start gap-2">
          <span className="flex size-10 items-center justify-center rounded-full bg-accent text-primary">
            <KeyRound aria-hidden className="size-5" />
          </span>
          <h1 className="text-xl font-semibold">{t('auth.changePassword.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.changePassword.intro')}</p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-current`}>{t('auth.changePassword.current')}</Label>
            <PasswordInput
              id={`${id}-current`}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              labels={labels}
              data-testid="choose-current"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-new`}>{t('auth.changePassword.new')}</Label>
            <PasswordInput
              id={`${id}-new`}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              aria-describedby={`${id}-hint`}
              labels={labels}
              data-testid="choose-new"
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {t('auth.changePassword.hint', { min: String(PASSWORD_MIN_LENGTH) })}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-repeat`}>{t('auth.changePassword.confirm')}</Label>
            <PasswordInput
              id={`${id}-repeat`}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              labels={labels}
              data-testid="choose-repeat"
            />
          </div>
          <Notice text={problem} tone="error" />
          <Button type="submit" disabled={busy || !current} data-testid="choose-submit">
            {t('auth.changePassword.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => void store.logout()}>
            {t('auth.changePassword.signOut')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
