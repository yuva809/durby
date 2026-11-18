'use client';

import { LOCALES, type Locale } from '@durby/i18n';
import {
  INVITATION_TTL_DAYS,
  type LocationSummary,
  PASSWORD_MIN_LENGTH,
  type PermissionKey,
  type Role,
  type TeamMember,
} from '@durby/shared';
import { CheckCircle2, KeyRound, Lock, Mail } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { roleName } from '../../lib/rbac/roles';
import { createTeamMember, updateTeamMember } from '../../lib/team/api';
import {
  canToggle,
  CRUD_COLUMNS,
  crudRow,
  generatePassword,
  overridesOf,
  selectedOf,
  visiblePermissions,
} from '../../lib/team/matrix';
import { useActionKey } from '../../lib/use-action-key';
import { areaLabel, permissionLabel, type UsersAccess } from '../../lib/users/access';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { PasswordInput } from '../ui/password-input';
import { Select } from '../ui/select';
import { ShareLink } from './share-link';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The matrix columns: the area, then View, Create, Edit and Delete (ADR 0037). */
const MATRIX_GRID =
  'grid grid-cols-[minmax(0,1fr)_repeat(4,2.75rem)] items-center gap-x-1 sm:grid-cols-[minmax(0,1fr)_repeat(4,4rem)]';

type Result =
  | { kind: 'created'; name: string }
  | {
      kind: 'invited';
      name: string;
      invitationId: string;
      existingAccount: boolean;
      emailed: boolean;
    };

/**
 * Add or edit a staff member (docs/platform/rbac.md → Manage Staff): details, role, locations and
 * the permission matrix. After adding: how they sign in (temporary password) or the invite link.
 */
export function StaffDialog({
  member,
  open,
  onOpenChange,
  roles,
  grantable,
  locations,
  access,
  activeFeatures,
  organizationName,
  passwordsFinal = false,
  onSaved,
}: {
  /** Absent: add someone. */
  member?: TeamMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly Role[];
  /** The roles the user may give (Owner only by Owners, others by the subset rule). */
  grantable: readonly Role[];
  locations: readonly LocationSummary[] | null;
  access: UsersAccess;
  activeFeatures: readonly string[];
  organizationName: string;
  /** Owners and admins set staff passwords (team.adminsManageSignIn, ADR 0052): the one given here is final. */
  passwordsFinal?: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const [result, setResult] = useState<Result | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setResult(null);
      }}
    >
      <DialogContent
        closeLabel={t('platform.common.close')}
        // One scroller: the form's body. The box itself never scrolls, so the header and the
        // buttons stay put and no empty space is left under them.
        className={cn('gap-0 overflow-hidden p-0 sm:max-w-5xl', result && 'sm:max-w-lg')}
        data-testid="team-dialog"
      >
        {result ? (
          <ResultView
            result={result}
            organizationName={organizationName}
            passwordsFinal={passwordsFinal}
            onDone={() => {
              setResult(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <StaffForm
            key={member?.membershipId ?? 'new'}
            member={member}
            roles={roles}
            grantable={grantable}
            locations={locations}
            access={access}
            activeFeatures={activeFeatures}
            passwordsFinal={passwordsFinal}
            onSaved={(r) => {
              onSaved();
              if (r) setResult(r);
              else onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StaffForm({
  member,
  roles,
  grantable,
  locations,
  access,
  activeFeatures,
  passwordsFinal,
  onSaved,
  onCancel,
}: {
  member?: TeamMember;
  roles: readonly Role[];
  grantable: readonly Role[];
  locations: readonly LocationSummary[] | null;
  access: UsersAccess;
  activeFeatures: readonly string[];
  passwordsFinal: boolean;
  onSaved: (result: Result | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const editing = member !== undefined;
  // A member keeps their current role in the picker even if it isn't grantable (it can't be chosen).
  const choices = useMemo(() => {
    const list = [...grantable];
    const current = member?.role ? roles.find((r) => r.id === member.role?.id) : undefined;
    if (current && !list.some((r) => r.id === current.id)) list.unshift(current);
    return list;
  }, [grantable, roles, member]);

  const [name, setName] = useState(member?.name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [password, setPassword] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  // Empty: the organization's language (the api reads the setting).
  const [locale, setLocale] = useState<Locale | ''>('');
  // A new person starts with the least-privileged role you can give, never Owner.
  const [roleId, setRoleId] = useState(
    member?.role?.id ??
      [...choices]
        .filter((r) => r.systemKey !== 'owner')
        .sort((a, b) => a.permissions.length - b.permissions.length)[0]?.id ??
      '',
  );
  const [allLocations, setAllLocations] = useState(member?.allLocations ?? true);
  const [locationIds, setLocationIds] = useState<string[]>(member?.locationIds ?? []);
  const role = roles.find((r) => r.id === roleId);
  const roleKeys = useMemo(() => new Set(role?.permissions ?? []), [role]);
  const [selected, setSelected] = useState<Set<string>>(() =>
    selectedOf(roleKeys, { grants: member?.grants ?? [], denies: member?.denies ?? [] }),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const owner = role?.systemKey === 'owner';
  const { groups, hiddenModules } = visiblePermissions(activeFeatures);
  const visibleKeys = groups.flatMap((g) => g.keys);
  const toggleable = new Set<string>(visibleKeys.filter((key) => canToggle(access, key)));

  function chooseRole(next: Role) {
    setRoleId(next.id);
    // A new role starts from its own defaults.
    setSelected(new Set(next.permissions));
    if (next.systemKey === 'owner') setAllLocations(true);
  }

  function toggle(key: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function submit() {
    setProblem(null);
    const trimmed = name.trim();
    if (!trimmed) return setProblem(t('platform.team.dialog.nameRequired'));
    if (!editing && !EMAIL.test(email.trim())) {
      return setProblem(t('platform.team.dialog.emailRequired'));
    }
    if (password && password.length < PASSWORD_MIN_LENGTH) {
      return setProblem(
        t('platform.team.dialog.passwordTooShort', { min: String(PASSWORD_MIN_LENGTH) }),
      );
    }
    if (!allLocations && locationIds.length === 0) {
      return setProblem(t('platform.members.form.locationsRequired'));
    }
    const overrides = owner ? { grants: [], denies: [] } : overridesOf(roleKeys, selected);
    const scope = allLocations ? null : locationIds;
    setBusy(true);
    if (editing) {
      const res = await updateTeamMember(store, action, member.membershipId, {
        name: trimmed,
        phone: phone.trim() || null,
        roleId,
        locationIds: scope,
        ...overrides,
      });
      setBusy(false);
      if (res.ok) onSaved(null);
      else setProblem(t(errorLabel(res.code)));
      return;
    }
    const res = await createTeamMember(store, action, {
      name: trimmed,
      email: email.trim(),
      ...(phone.trim() && { phone: phone.trim() }),
      roleId,
      locationIds: scope,
      ...overrides,
      ...(password && { temporaryPassword: password }),
      sendEmail,
      ...(locale && { locale }),
    });
    setBusy(false);
    if (!res.ok || !res.data) return setProblem(t(errorLabel(res.ok ? 'unknown' : res.code)));
    onSaved(
      res.data.kind === 'created'
        ? { kind: 'created', name: trimmed }
        : {
            kind: 'invited',
            name: trimmed,
            invitationId: res.data.invitationId,
            existingAccount: res.data.existingAccount,
            emailed: sendEmail,
          },
    );
  }

  const changed = (key: string) => selected.has(key) !== roleKeys.has(key);
  const count = visibleKeys.filter((key) => selected.has(key)).length;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <div className="border-b px-6 pt-6 pb-4 pr-14">
        <DialogTitle>
          {editing
            ? t('platform.team.dialog.editTitle', { name: member.name ?? member.email })
            : t('platform.team.dialog.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('platform.team.dialog.description')}</DialogDescription>
      </div>

      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        {/* Details, role, locations */}
        <section
          className="flex flex-col gap-4 md:sticky md:top-0 md:self-start"
          aria-labelledby={`${id}-details`}
        >
          <h3
            id={`${id}-details`}
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            {t('platform.team.dialog.details')}
          </h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('platform.team.dialog.name')}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              maxLength={100}
              data-testid="team-name"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-email`}>{t('platform.team.dialog.email')}</Label>
            <Input
              id={`${id}-email`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={editing}
              autoComplete="off"
              data-testid="team-email"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-phone`}>{t('platform.team.dialog.phone')}</Label>
            <Input
              id={`${id}-phone`}
              type="tel"
              inputMode="tel"
              value={phone}
              placeholder={t('platform.team.dialog.phonePlaceholder')}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              data-testid="team-phone"
            />
          </div>
          {!editing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-locale`}>{t('platform.team.dialog.language')}</Label>
              <Select
                id={`${id}-locale`}
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale | '')}
                aria-describedby={`${id}-locale-hint`}
                data-testid="team-locale"
              >
                <option value="">{t('platform.team.dialog.languageOrganization')}</option>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {t(`platform.account.languages.${l}`)}
                  </option>
                ))}
              </Select>
              <p id={`${id}-locale-hint`} className="text-xs text-muted-foreground">
                {t('platform.team.dialog.languageHint')}
              </p>
            </div>
          )}
          {!editing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-password`}>
                {t(
                  passwordsFinal
                    ? 'platform.team.dialog.passwordFinal'
                    : 'platform.team.dialog.password',
                )}
              </Label>
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
                    data-testid="team-password"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPassword(generatePassword())}
                  data-testid="team-generate"
                >
                  <KeyRound aria-hidden />
                  {t('platform.team.dialog.generate')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  passwordsFinal
                    ? 'platform.team.dialog.passwordHintFinal'
                    : 'platform.team.dialog.passwordHint',
                  { min: String(PASSWORD_MIN_LENGTH) },
                )}
              </p>
              {!password && (
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <Checkbox
                    checked={sendEmail}
                    onCheckedChange={(v) => setSendEmail(v === true)}
                    data-testid="team-send-email"
                  />
                  {t('platform.team.dialog.sendEmail')}
                </label>
              )}
            </div>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t('platform.team.dialog.role')}</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {choices.map((r) => {
                const chosen = r.id === roleId;
                const allowed = grantable.some((g) => g.id === r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    disabled={!allowed}
                    onClick={() => chooseRole(r)}
                    className={cn(
                      'min-h-11 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50',
                      chosen ? 'border-primary bg-accent font-medium' : 'bg-card hover:bg-muted',
                    )}
                    data-testid="team-role"
                    data-role={r.systemKey ?? r.name ?? ''}
                  >
                    {roleName(r, t)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {locations && locations.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1.5 text-sm font-medium">
                {t('platform.team.dialog.locations')}
              </legend>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <Checkbox
                  checked={allLocations}
                  disabled={owner}
                  onCheckedChange={(v) => setAllLocations(v === true)}
                  data-testid="team-all-locations"
                />
                {t('platform.team.dialog.allLocations')}
              </label>
              {!allLocations &&
                locations.map((location) => (
                  <label
                    key={location.id}
                    className="flex min-h-11 items-center gap-3 pl-6 text-sm"
                  >
                    <Checkbox
                      checked={locationIds.includes(location.id)}
                      onCheckedChange={(v) =>
                        setLocationIds((ids) =>
                          v === true ? [...ids, location.id] : ids.filter((x) => x !== location.id),
                        )
                      }
                    />
                    {location.name}
                  </label>
                ))}
            </fieldset>
          )}
        </section>

        {/* Permission matrix */}
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby={`${id}-permissions`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id={`${id}-permissions`}
              className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {t('platform.team.dialog.permissions')}
            </h3>
            <span className="text-sm text-muted-foreground" data-testid="team-selected-count">
              {t('platform.team.dialog.selected', { count: String(count) })}
            </span>
          </div>
          {owner ? (
            <p className="rounded-md bg-accent px-3 py-2 text-sm">
              {t('platform.team.dialog.ownerAll')}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSelected(new Set(roleKeys))}
                >
                  {t('platform.team.dialog.roleDefaults')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSelected((s) => new Set([...s, ...toggleable]))}
                >
                  {t('platform.team.dialog.selectAll')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setSelected((s) => new Set([...s].filter((key) => !toggleable.has(key))))
                  }
                >
                  {t('platform.team.dialog.clear')}
                </Button>
              </div>
              <div className="flex flex-col rounded-lg border" data-testid="team-matrix">
                <div
                  className={cn(
                    MATRIX_GRID,
                    'border-b px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
                  )}
                  aria-hidden
                >
                  <span>{t('platform.team.dialog.column.module')}</span>
                  {CRUD_COLUMNS.map((verb) => (
                    <span key={verb} className="text-center">
                      {t(`platform.team.dialog.column.${verb}`)}
                    </span>
                  ))}
                </div>
                <div className="flex flex-col divide-y">
                  {groups.map((group) => (
                    <MatrixRow
                      key={group.area}
                      area={group.area}
                      keys={group.keys}
                      selected={selected}
                      access={access}
                      changed={changed}
                      onToggle={toggle}
                      onToggleAll={(on) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const key of group.keys) {
                            if (!canToggle(access, key)) continue;
                            if (on) next.add(key);
                            else next.delete(key);
                          }
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('platform.team.dialog.matrixNote')}
              </p>
              {hiddenModules.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('platform.team.dialog.hiddenModules', {
                    modules: hiddenModules.map((label) => t(label)).join(', '),
                  })}
                </p>
              )}
            </>
          )}
        </section>
      </div>

      <div className="flex flex-col gap-3 border-t px-6 py-4">
        <Notice text={problem} tone="error" />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('platform.common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || !roleId} data-testid="team-save">
            {t(editing ? 'platform.team.dialog.save' : 'platform.team.dialog.create')}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * One area of the matrix. An entity with create, edit or delete keys is a row of View, Create, Edit and Delete
 * cells (blank where the key doesn't exist) with its other keys listed under it; any other area lists its keys.
 * The box in front ticks or clears the whole area (only the keys you may change).
 */
function MatrixRow({
  area,
  keys,
  selected,
  access,
  changed,
  onToggle,
  onToggleAll,
}: {
  area: string;
  keys: readonly PermissionKey[];
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}) {
  const t = useT();
  const areaName = t(areaLabel(area));
  const row = crudRow(keys);
  const ticked = keys.filter((key) => selected.has(key)).length;
  const anyToggleable = keys.some((key) => canToggle(access, key));
  const listed = (row ? row.extra : keys) as PermissionKey[];

  return (
    <div className="px-3 py-1.5" data-testid="team-matrix-row" data-area={area}>
      <div className={MATRIX_GRID}>
        <label className="flex min-h-11 min-w-0 items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={ticked === 0 ? false : ticked === keys.length ? true : 'indeterminate'}
            disabled={!anyToggleable}
            onCheckedChange={(v) => onToggleAll(v === true)}
            aria-label={t('platform.team.dialog.wholeArea', { area: areaName })}
            data-testid="team-permission-area"
            data-area={area}
          />
          <span className="truncate" title={areaName}>
            {areaName}
          </span>
        </label>
        {row &&
          CRUD_COLUMNS.map((verb) => {
            const key = row.cells[verb] as PermissionKey | null;
            return (
              <div key={verb} className="flex justify-center">
                {key && (
                  <PermissionBox
                    permission={key}
                    selected={selected}
                    access={access}
                    changed={changed}
                    onToggle={onToggle}
                    labelled={false}
                  />
                )}
              </div>
            );
          })}
      </div>
      {listed.length > 0 && (
        <div className="flex flex-wrap gap-x-4 pl-7">
          {listed.map((key) => (
            <PermissionBox
              key={key}
              permission={key}
              selected={selected}
              access={access}
              changed={changed}
              onToggle={onToggle}
              labelled
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One permission's box: its label beside it in lists, only as the accessible name in a CRUD cell. */
function PermissionBox({
  permission,
  selected,
  access,
  changed,
  onToggle,
  labelled,
}: {
  permission: PermissionKey;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
  labelled: boolean;
}) {
  const t = useT();
  const locked = !canToggle(access, permission);
  const name = t(permissionLabel(permission));
  return (
    <label
      className={cn(
        'relative flex min-h-11 items-center gap-2 text-sm',
        !labelled && 'min-w-11 justify-center',
        locked && 'text-muted-foreground',
      )}
      title={locked ? `${name}: ${t('platform.team.dialog.locked')}` : name}
    >
      <Checkbox
        checked={selected.has(permission)}
        disabled={locked}
        onCheckedChange={(v) => onToggle(permission, v === true)}
        aria-label={labelled ? undefined : name}
        data-testid="team-permission"
        data-key={permission}
      />
      {labelled && name}
      {labelled && locked && <Lock aria-hidden className="size-3.5" />}
      {changed(permission) && (
        <span
          className={cn(
            'size-2 rounded-full bg-primary',
            !labelled && 'absolute top-1.5 right-0.5',
          )}
          title={t('platform.team.dialog.changed')}
          aria-label={t('platform.team.dialog.changed')}
          data-testid="team-permission-changed"
        />
      )}
    </label>
  );
}

function ResultView({
  result,
  organizationName,
  passwordsFinal,
  onDone,
}: {
  result: Result;
  organizationName: string;
  passwordsFinal: boolean;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6" data-testid="team-result">
      <div className="flex items-start gap-3 pr-8">
        {result.kind === 'created' ? (
          <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0 text-primary" />
        ) : (
          <Mail aria-hidden className="mt-0.5 size-6 shrink-0 text-primary" />
        )}
        <div className="flex flex-col gap-1">
          <DialogTitle>
            {result.kind === 'created'
              ? t('platform.team.result.createdTitle', { name: result.name })
              : t('platform.team.result.invitedTitle', { name: result.name })}
          </DialogTitle>
          <DialogDescription>
            {result.kind === 'created'
              ? t(
                  passwordsFinal
                    ? 'platform.team.result.createdBodyFinal'
                    : 'platform.team.result.createdBody',
                )
              : t('platform.team.result.invitedBody', { days: String(INVITATION_TTL_DAYS) })}
          </DialogDescription>
        </div>
      </div>
      {result.kind === 'invited' && (
        <>
          {result.existingAccount && (
            <p className="rounded-md bg-accent px-3 py-2 text-sm">
              {t('platform.team.result.existingAccount')}
            </p>
          )}
          {result.emailed && (
            <p className="text-sm text-muted-foreground">{t('platform.team.result.emailed')}</p>
          )}
          <ShareLink invitationId={result.invitationId} organizationName={organizationName} />
        </>
      )}
      <div className="flex justify-end">
        <Button onClick={onDone} data-testid="team-done">
          {t('platform.team.result.done')}
        </Button>
      </div>
    </div>
  );
}
