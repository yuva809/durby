'use client';

import { STAFF_ROLES, type StaffMember, type StaffRole, staffRoleLabel } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { UserX } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { fieldClass, formText, Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffApi, type StaffResult } from '../../lib/staff/api';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { StaffNoAccess } from './portal-shell';
import { useReauth } from './reauth';
import { useStaffSession } from './staff-session';

const roleLabel = (role: StaffRole) => t(staffRoleLabel(role) as LabelKey);
type Guard = ReturnType<typeof useReauth>['guard'];

/**
 * /platform/staff (docs/platform/admin-portal.md → Staff management): everyone with
 * staff.staff.read sees the list; changes need staff.staff.manage and a recent confirmation.
 */
export function StaffPage() {
  const { session, reload: reloadSession } = useStaffSession();
  const canRead =
    session.status === 'signedIn' && session.me.permissions.includes('staff.staff.read');
  // Only with staff.staff.read: other roles never request the list.
  const [list, reload] = useResource(canRead ? 'staff' : null, staffApi.listStaff);
  const [notice, setNotice] = useState<string | null>(null);
  const { guard, dialog } = useReauth(() => void reloadSession());

  if (session.status !== 'signedIn') return null;
  const permissions = new Set<string>(session.me.permissions);
  if (!permissions.has('staff.staff.read')) return <StaffNoAccess />;
  const canManage = permissions.has('staff.staff.manage');
  const myId = session.me.id;

  const done = (message: string | null) => {
    setNotice(message);
    reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t('staff.nav.staff')}</h1>
        {canManage && (
          <InviteDialog guard={guard} onDone={() => done(t('staff.staffPage.invited'))} />
        )}
      </div>
      <Notice text={notice} tone="info" />
      {list.status === 'error' ? (
        <Notice text={t(errorLabel(list.code))} tone="error" />
      ) : list.status === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="staff-table">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">{t('staff.staffPage.email')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.staffPage.role')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.staffPage.status')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.staffPage.lastLogin')}</th>
                {canManage && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.data.data.map((member) => {
                const self = member.id === myId;
                const editable = canManage && !self && member.status !== 'deactivated';
                return (
                  <tr key={member.id} data-testid="staff-row" data-email={member.email}>
                    <td className="px-4 py-3 font-medium">
                      {member.email}{' '}
                      {self && (
                        <span className="text-muted-foreground">{t('staff.staffPage.you')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editable ? (
                        <RoleSelect
                          member={member}
                          guard={guard}
                          onDone={() => done(null)}
                          onError={setNotice}
                        />
                      ) : (
                        roleLabel(member.role)
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={cn(
                          member.status === 'active' && 'border-primary text-foreground',
                          member.status === 'deactivated' && 'line-through',
                        )}
                      >
                        {t(`staff.status.${member.status}` as LabelKey)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {member.lastLoginAt
                        ? new Date(member.lastLoginAt).toLocaleString()
                        : t('staff.staffPage.never')}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        {editable && (
                          <span className="flex justify-end gap-2">
                            <Confirm
                              testId="staff-deactivate"
                              icon={<UserX aria-hidden />}
                              trigger={t('staff.staffPage.deactivate', { email: member.email })}
                              title={t('staff.staffPage.deactivateTitle', { email: member.email })}
                              description={t('staff.staffPage.deactivateDescription')}
                              confirm={t('staff.staffPage.deactivateConfirm')}
                              run={() => guard(() => staffApi.deactivate(member.id))}
                              onDone={() => done(null)}
                            />
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {dialog}
    </div>
  );
}

function RoleSelect({
  member,
  guard,
  onDone,
  onError,
}: {
  member: StaffMember;
  guard: Guard;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Select
      aria-label={t('staff.staffPage.changeRole', { email: member.email })}
      className="min-h-9 w-auto text-sm"
      value={member.role}
      disabled={busy}
      data-testid="staff-role"
      onChange={(e) => {
        const role = e.target.value as StaffRole;
        setBusy(true);
        void guard(() => staffApi.changeRole(member.id, role)).then((result) => {
          setBusy(false);
          if (result.ok) onDone();
          else onError(t(errorLabel(result.code)));
        });
      }}
    >
      {STAFF_ROLES.map((role) => (
        <option key={role} value={role}>
          {roleLabel(role)}
        </option>
      ))}
    </Select>
  );
}

function InviteDialog({ guard, onDone }: { guard: Guard; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = formText(form, 'email').trim();
    if (!email) {
      setError(t('staff.staffPage.emailRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    const role = formText(form, 'role') as StaffRole;
    const result = await guard(() => staffApi.invite({ email, role }));
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
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="staff-invite">{t('staff.staffPage.invite')}</Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')} aria-describedby={undefined}>
        <DialogTitle>{t('staff.staffPage.inviteTitle')}</DialogTitle>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="mt-2">
          <label className={fieldClass}>
            {t('staff.staffPage.email')}
            <Input name="email" type="email" autoComplete="off" data-testid="staff-invite-email" />
          </label>
          <label className={fieldClass}>
            {t('staff.staffPage.role')}
            <Select name="role" defaultValue="support" data-testid="staff-invite-role">
              {STAFF_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
          </label>
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('platform.common.cancel')}
            </Button>
            <Button type="submit" disabled={busy} data-testid="staff-invite-send">
              {t('staff.staffPage.invite')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An icon button behind a confirm dialog; the error stays in the dialog. */
function Confirm({
  testId,
  icon,
  trigger,
  title,
  description,
  confirm,
  run,
  onDone,
}: {
  testId: string;
  icon: ReactNode;
  trigger: string;
  title: string;
  description: string;
  confirm: string;
  run: () => Promise<StaffResult<unknown>>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      onDone();
    } else {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={trigger}
          title={trigger}
          data-testid={testId}
        >
          {icon}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <Notice text={error} tone="error" />
        <AlertDialogFooter>
          <AlertDialogCancel>{t('platform.common.cancel')}</AlertDialogCancel>
          {/* Not AlertDialogAction: that closes the dialog before the answer is known. */}
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void onConfirm()}
            data-testid={`${testId}-confirm`}
          >
            {confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
