'use client';

import { isPermissionKey, type PermissionKey, type Role } from '@durby/shared';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { roleName } from '../../lib/rbac/roles';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import {
  areaLabel,
  canEditCustomRole,
  canOfferPermission,
  isLocationScoped,
  permissionGroups,
  permissionLabel,
  type UsersAccess,
  usersAccessOf,
} from '../../lib/users/access';
import { createRole, deleteRole, loadRoles, updateRole } from '../../lib/users/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
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
import { ConfirmAction, Loaded, NoAccess } from './common';

/** The Roles tab of Manage Staff (docs/platform/web-shell.md → Roles page). */
export function RolesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const access = usersAccessOf(session);
  if (!access.canReadRoles) return <NoAccess title="platform.nav.roles" />;
  return <Roles access={access} organizationId={session.activeOrganizationId} />;
}

function Roles({ access, organizationId }: { access: UsersAccess; organizationId: string | null }) {
  const t = useT();
  const { store, session } = useAuth();
  const [roles, reload] = useResource(organizationId, () => loadRoles(store));

  /** After a change to the user's own role, refresh the session so its hints follow. */
  const changed = (role: Pick<Role, 'id'>) => {
    reload();
    if (session?.activeRole?.id === role.id) void store.refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('platform.nav.roles')}</h1>
        {access.canManageRoles && <RoleDialog access={access} onDone={changed} />}
      </div>
      <Loaded resource={roles} reload={reload}>
        {(list) => (
          <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-3" aria-labelledby="system-roles">
              <h2 id="system-roles" className="text-lg font-medium">
                {t('platform.rolesPage.system')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('platform.rolesPage.systemDescription')}
              </p>
              {list
                .filter((r) => r.systemKey !== null)
                .map((role) => (
                  <RoleCard key={role.id} role={role} />
                ))}
            </section>
            <section className="flex flex-col gap-3" aria-labelledby="custom-roles">
              <h2 id="custom-roles" className="text-lg font-medium">
                {t('platform.rolesPage.custom')}
              </h2>
              {list.every((r) => r.systemKey !== null) && (
                <p className="text-muted-foreground">{t('platform.rolesPage.customEmpty')}</p>
              )}
              {list
                .filter((r) => r.systemKey === null)
                .map((role) => (
                  <RoleCard key={role.id} role={role}>
                    {canEditCustomRole(access, role) && (
                      <>
                        <RoleDialog access={access} role={role} onDone={changed} />
                        <DeleteRole role={role} onDone={() => changed(role)} />
                      </>
                    )}
                  </RoleCard>
                ))}
            </section>
          </div>
        )}
      </Loaded>
    </div>
  );
}

function DeleteRole({ role, onDone }: { role: Role; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ConfirmAction
      testId="role-delete"
      trigger={t('platform.rolesPage.delete')}
      title={t('platform.rolesPage.deleteTitle')}
      description={t('platform.rolesPage.deleteDescription', { role: roleName(role, t) })}
      confirm={t('platform.rolesPage.delete')}
      run={() => deleteRole(store, action, role.id)}
      onDone={onDone}
    />
  );
}

/** A role with its permissions grouped by area; `children` are its actions. */
function RoleCard({ role, children }: { role: Role; children?: ReactNode }) {
  const t = useT();
  const groups = permissionGroups(role.permissions);
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="role-card" data-role={roleName(role, t)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{roleName(role, t)}</h3>
        {children && <div className="flex flex-wrap gap-2">{children}</div>}
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('platform.rolesPage.noPermissions')}</p>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.area}>
              <dt className="text-sm font-medium text-muted-foreground">
                {t(areaLabel(group.area))}
              </dt>
              <dd>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {group.keys.map((key) => (
                    <li key={key} className="flex flex-wrap items-center gap-2">
                      {t(permissionLabel(key))}
                      {isLocationScoped(key) && (
                        <Badge>{t('platform.rolesPage.perLocation')}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

/**
 * Create (no `role`) or edit a custom role. Offers only keys the actor holds; the others are
 * shown disabled with the reason (docs/platform/web-shell.md → Roles page).
 */
function RoleDialog({
  access,
  role,
  onDone,
}: {
  access: UsersAccess;
  role?: Role;
  onDone: (role: Role) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const initialKeys = (role?.permissions ?? []).filter(isPermissionKey);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(role?.name ?? '');
  const [keys, setKeys] = useState<PermissionKey[]>(initialKeys);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameMissing = checked && name.trim() === '';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (name.trim() === '') return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), permissions: keys };
    const result = role
      ? await updateRole(store, action, role.id, body)
      : await createRole(store, action, body);
    setBusy(false);
    if (result.ok && result.data) {
      setOpen(false);
      onDone(result.data);
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  const toggle = (key: PermissionKey, on: boolean) =>
    setKeys((current) => (on ? [...current, key] : current.filter((k) => k !== key)));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(role?.name ?? '');
          setKeys(initialKeys);
          setChecked(false);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        {role ? (
          <Button variant="outline" data-testid="role-edit">
            {t('platform.rolesPage.edit')}
          </Button>
        ) : (
          <Button data-testid="role-create">{t('platform.rolesPage.create')}</Button>
        )}
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')} className="max-w-2xl">
        <DialogTitle>
          {t(role ? 'platform.rolesPage.editTitle' : 'platform.rolesPage.createTitle')}
        </DialogTitle>
        <DialogDescription>{t('platform.rolesPage.editorDescription')}</DialogDescription>
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('platform.rolesPage.name')}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={100}
              aria-invalid={nameMissing || undefined}
              aria-describedby={nameMissing ? `${id}-name-problem` : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {nameMissing && (
              <p id={`${id}-name-problem`} role="alert" className="text-sm text-destructive">
                {t('platform.rolesPage.nameRequired')}
              </p>
            )}
          </div>
          {permissionGroups().map((group) => (
            <fieldset key={group.area} className="grid gap-1">
              <legend className="mb-1 text-sm font-medium">{t(areaLabel(group.area))}</legend>
              {group.keys.map((key) => {
                const offered = canOfferPermission(access, key);
                const hint = `${id}-${key}-hint`;
                return (
                  <div key={key} className="flex min-h-11 flex-wrap items-center gap-3">
                    <Checkbox
                      id={`${id}-${key}`}
                      data-testid={`permission-${key}`}
                      checked={keys.includes(key)}
                      disabled={!offered}
                      aria-describedby={offered ? undefined : hint}
                      onCheckedChange={(next) => toggle(key, next === true)}
                    />
                    <Label htmlFor={`${id}-${key}`} className="font-normal">
                      {t(permissionLabel(key))}
                    </Label>
                    {isLocationScoped(key) && <Badge>{t('platform.rolesPage.perLocation')}</Badge>}
                    {!offered && (
                      <span id={hint} className="text-xs text-muted-foreground">
                        {t('platform.rolesPage.notHeld')}
                      </span>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('platform.common.cancel')}
            </Button>
            <Button type="submit" disabled={busy} data-testid="role-save">
              {t('platform.common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
