'use client';

import { PASSWORD_MIN_LENGTH, type TeamMember } from '@durby/shared';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { setTeamMemberPassword } from '../../lib/team/api';
import { generatePassword } from '../../lib/team/matrix';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog';
import { Label } from '../ui/label';
import { PasswordInput } from '../ui/password-input';

/**
 * Set password (ADR 0052): an owner or admin gives a member a new password. Final where owners and admins set
 * staff passwords (`passwordsFinal`), else temporary: the member chooses their own at the next sign-in. Either
 * way every session of theirs ends.
 */
export function PasswordDialog({
  member,
  passwordsFinal,
  onClose,
  onDone,
}: {
  member: TeamMember | null;
  passwordsFinal: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('platform.common.close')} data-testid="team-password-dialog">
        {member && (
          <PasswordForm
            key={member.membershipId}
            member={member}
            passwordsFinal={passwordsFinal}
            onClose={onClose}
            onDone={onDone}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PasswordForm({
  member,
  passwordsFinal,
  onClose,
  onDone,
}: {
  member: TeamMember;
  passwordsFinal: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const name = member.name ?? member.email;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t('platform.team.dialog.passwordTooShort', { min: String(PASSWORD_MIN_LENGTH) }));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await setTeamMemberPassword(store, action, member.membershipId, { password });
    setBusy(false);
    if (result.ok) {
      setDone(true);
      onDone();
    } else setError(t(errorLabel(result.code)));
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4" data-testid="team-password-done">
        <DialogTitle>{t('platform.team.setPassword.doneTitle', { name })}</DialogTitle>
        <DialogDescription>
          {t(
            passwordsFinal
              ? 'platform.team.setPassword.doneFinal'
              : 'platform.team.setPassword.doneTemporary',
          )}
        </DialogDescription>
        <DialogFooter>
          <Button onClick={onClose}>{t('platform.common.close')}</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <DialogTitle>{t('platform.team.setPassword.title', { name })}</DialogTitle>
      <DialogDescription>
        {t(
          passwordsFinal
            ? 'platform.team.setPassword.introFinal'
            : 'platform.team.setPassword.introTemporary',
        )}
      </DialogDescription>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-password`}>{t('platform.team.dialog.passwordFinal')}</Label>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <PasswordInput
              id={`${id}-password`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              labels={{
                show: t('platform.team.dialog.showPassword'),
                hide: t('platform.team.dialog.hidePassword'),
              }}
              data-testid="team-new-password"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPassword(generatePassword())}
            data-testid="team-new-password-generate"
          >
            <KeyRound aria-hidden />
            {t('platform.team.dialog.generate')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('platform.team.setPassword.hint', { min: String(PASSWORD_MIN_LENGTH) })}
        </p>
      </div>
      <Notice text={error} tone="error" />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('platform.common.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={busy || password === ''}
          data-testid="team-new-password-save"
        >
          {t('platform.team.setPassword.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
