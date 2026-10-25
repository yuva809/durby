'use client';

import type { LocationSummary, Member, Role } from '@durby/shared';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { useActionKey } from '../../lib/use-action-key';
import { createInvitation, updateMember } from '../../lib/users/api';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { normalizeScope, ScopeFields, scopeProblem, type ScopeValue } from './scope-fields';

/** Change a member's role and locations (`platform.users.manage`, only when grantable). */
export function ChangeMemberDialog({
  member,
  roles,
  locations,
  onDone,
}: {
  member: Member;
  roles: readonly Role[];
  locations: readonly LocationSummary[] | null;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const initial: ScopeValue = {
    roleId: member.role?.id ?? '',
    allLocations: member.allLocations,
    locationIds: member.locationIds,
  };
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = checked ? scopeProblem(value) : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (scopeProblem(value)) return;
    const body: { roleId?: string; locationIds?: string[] | null } = {};
    if (value.roleId !== initial.roleId) body.roleId = value.roleId;
    const scopeChanged =
      value.allLocations !== initial.allLocations ||
      [...value.locationIds].sort().join() !== [...initial.locationIds].sort().join();
    if (locations !== null && scopeChanged) {
      body.locationIds = value.allLocations ? null : value.locationIds;
    }
    if (Object.keys(body).length === 0) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updateMember(store, action, member.id, body);
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      onDone();
    } else {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(initial);
          setChecked(false);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="member-change">
          {t('platform.members.change')}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')}>
        <DialogTitle>{t('platform.members.changeTitle')}</DialogTitle>
        <DialogDescription>{member.email}</DialogDescription>
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          <ScopeFields
            value={value}
            onChange={setValue}
            roles={roles}
            locations={locations}
            problem={problem}
          />
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('platform.common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t('platform.common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Invite by email with a grantable role and an optional location scope. */
export function InviteDialog({
  roles,
  locations,
  onSent,
}: {
  roles: readonly Role[];
  locations: readonly LocationSummary[] | null;
  onSent: (email: string) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const empty: ScopeValue = { roleId: '', allLocations: true, locationIds: [] };
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [value, setValue] = useState(empty);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailMissing = checked && !/^\S+@\S+\.\S+$/.test(email.trim());
  const problem = checked ? scopeProblem(value) : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (!/^\S+@\S+\.\S+$/.test(email.trim()) || scopeProblem(value)) return;
    const scope = normalizeScope(value, roles);
    setBusy(true);
    setError(null);
    const result = await createInvitation(store, action, {
      email: email.trim(),
      roleId: scope.roleId,
      locationIds: scope.allLocations ? null : scope.locationIds,
    });
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      onSent(email.trim());
    } else {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setEmail('');
          setValue(empty);
          setChecked(false);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="invite-open">{t('platform.invitations.invite')}</Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')}>
        <DialogTitle>{t('platform.invitations.inviteTitle')}</DialogTitle>
        <DialogDescription>{t('platform.invitations.inviteDescription')}</DialogDescription>
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-email`}>{t('platform.invitations.email')}</Label>
            <Input
              id={`${id}-email`}
              type="email"
              autoComplete="off"
              value={email}
              aria-invalid={emailMissing || undefined}
              aria-describedby={emailMissing ? `${id}-email-problem` : undefined}
              onChange={(e) => setEmail(e.target.value)}
            />
            {emailMissing && (
              <p id={`${id}-email-problem`} role="alert" className="text-sm text-destructive">
                {t('platform.invitations.emailInvalid')}
              </p>
            )}
          </div>
          <ScopeFields
            value={value}
            onChange={setValue}
            roles={roles}
            locations={locations}
            problem={problem}
          />
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('platform.common.cancel')}
            </Button>
            <Button type="submit" disabled={busy} data-testid="invite-send">
              {t('platform.invitations.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
