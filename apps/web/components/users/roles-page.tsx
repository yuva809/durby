'use client';

import { isPermissionKey, PERMISSION_KEYS, type Role } from '@durby/shared';
import { type FormEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { roleName } from '../../lib/rbac/roles';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import {
  areaLabel,
  canDeleteCustomRole,
  canEditCustomRole,
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
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { PermissionMatrix, shownCount } from '../team/permission-matrix';
import { ConfirmAction, Loaded, NoAccess } from './common';

/** The Roles tab of Manage Staff (docs/platform/web-shell.md → Roles page). */
export function RolesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const access = usersAccessOf(session);
  if (!access.canReadRoles) return <NoAccess title="platform.nav.roles" />;
  return (
    <Roles
      access={access}
      organizationId={session.activeOrganizationId}
      activeFeatures={session.activeFeatures}
    />
  );
}

function Roles({
  access,
  organizationId,
  activeFeatures,
}: {
  access: UsersAccess;
  organizationId: string | null;
  activeFeatures: readonly string[];
}) {
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
        {access.canCreateRoles && (
          <RoleDialog access={access} activeFeatures={activeFeatures} onDone={changed} />
        )}
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
                      <RoleDialog
                        access={access}
                        activeFeatures={activeFeatures}
                        role={role}
                        onDone={changed}
                      />
                    )}
                    {canDeleteCustomRole(access, role) && (
                      <DeleteRole role={role} onDone={() => changed(role)} />
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
 * Create (no `role`) or edit a custom role with the same permission matrix as Manage Staff (ADR 0050): "Grant View
 * first", only keys the actor holds can change, switched-off modules hidden (their keys kept). Saving keeps the role's
 * keys in their saved order and adds new ones in registry order, so an unchanged save sends the same list.
 */
function RoleDialog({
  access,
  activeFeatures,
  role,
  onDone,
}: {
  access: UsersAccess;
  activeFeatures: readonly string[];
  role?: Role;
  onDone: (role: Role) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const initialKeys = useMemo(() => (role?.permissions ?? []).filter(isPermissionKey), [role]);
  const saved = useMemo(() => new Set<string>(initialKeys), [initialKeys]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(role?.name ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(saved));
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameMissing = checked && name.trim() === '';
  // A dot marks what differs from the saved role; a new role has nothing saved to differ from.
  const changed = (key: string) => role !== undefined && selected.has(key) !== saved.has(key);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (name.trim() === '') return;
    setBusy(true);
    setError(null);
    const permissions = [
      ...initialKeys.filter((key) => selected.has(key)),
      ...PERMISSION_KEYS.filter((key) => selected.has(key) && !saved.has(key)),
    ];
    const body = { name: name.trim(), permissions };
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(role?.name ?? '');
          setSelected(new Set(saved));
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
      <DialogContent
        closeLabel={t('platform.common.close')}
        className="gap-0 overflow-hidden p-0 sm:max-w-3xl"
        data-testid="role-dialog"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => void onSubmit(e)}
          noValidate
        >
          <div className="border-b px-6 pt-6 pb-4 pr-14">
            <DialogTitle>
              {t(role ? 'platform.rolesPage.editTitle' : 'platform.rolesPage.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('platform.rolesPage.editorDescription')}</DialogDescription>
          </div>
          {/* The scroll area: no top padding of its own, so the matrix header pins flush at the top. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
            <div className="flex flex-col gap-4 pt-5">
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
              <section
                className="flex min-w-0 flex-col gap-3"
                aria-labelledby={`${id}-permissions`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3
                    id={`${id}-permissions`}
                    className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    {t('platform.team.dialog.permissions')}
                  </h3>
                  <span className="text-sm text-muted-foreground" data-testid="role-selected-count">
                    {t('platform.team.dialog.selected', {
                      count: String(shownCount(selected, activeFeatures)),
                    })}
                  </span>
                </div>
                <PermissionMatrix
                  selected={selected}
                  onChange={setSelected}
                  access={access}
                  activeFeatures={activeFeatures}
                  changed={changed}
                  changedLabel="platform.rolesPage.changed"
                />
              </section>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t px-6 py-4">
            <Notice text={error} tone="error" />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('platform.common.cancel')}
              </Button>
              <Button type="submit" disabled={busy} data-testid="role-save">
                {t('platform.common.save')}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
