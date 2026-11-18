'use client';

import { LOCALES, type Locale } from '@durby/i18n';
import {
  INVITATION_TTL_DAYS,
  type LocationSummary,
  MATRIX_COLUMNS,
  PASSWORD_MIN_LENGTH,
  type PermissionKey,
  type Role,
  type TeamMember,
} from '@durby/shared';
import { CheckCircle2, Info, KeyRound, Lock, Mail } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { roleName } from '../../lib/rbac/roles';
import { createTeamMember, updateTeamMember } from '../../lib/team/api';
import {
  blockedByView,
  canToggle,
  generatePassword,
  type MatrixCell,
  type MatrixRow as MatrixRowData,
  type MatrixSection as MatrixSectionData,
  overridesOf,
  permissionMatrix,
  selectedOf,
  tickMany,
  tickOne,
} from '../../lib/team/matrix';
import { useActionKey } from '../../lib/use-action-key';
import { permissionLabel, type UsersAccess } from '../../lib/users/access';
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

/** The matrix columns: the row, then View, Create, Edit and Delete (ADR 0037, ADR 0050). */
const MATRIX_GRID =
  'grid grid-cols-[minmax(0,1fr)_repeat(4,2.75rem)] items-center gap-x-1 sm:grid-cols-[minmax(0,1fr)_repeat(4,4.5rem)]';

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
  const { sections, hiddenModules } = permissionMatrix(activeFeatures);
  const visibleKeys = sections.flatMap((s) => s.keys);
  const toggleable = new Set<string>(visibleKeys.filter((key) => canToggle(access, key)));

  function chooseRole(next: Role) {
    setRoleId(next.id);
    // A new role starts from its own defaults.
    setSelected(new Set(next.permissions));
    if (next.systemKey === 'owner') setAllLocations(true);
  }

  const may = (key: string) => canToggle(access, key);

  /** One box; "Grant View first": unticking View also clears its row's actions. */
  function toggle(key: string, on: boolean) {
    setSelected((current) => tickOne(current, key, on, may));
  }

  /** Ticks or clears a row or section: only the keys you may change, actions only with their View. */
  function toggleMany(keys: readonly string[], on: boolean) {
    setSelected((current) => tickMany(current, keys, on, may));
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

      {/* No top padding on the scroll area itself: the columns carry it, so the matrix header pins flush at the top. */}
      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 pb-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        {/* Details, role, locations */}
        <section
          className="flex flex-col gap-4 pt-5 md:sticky md:top-0 md:self-start"
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
        <section
          className="flex min-w-0 flex-col gap-3 md:pt-5"
          aria-labelledby={`${id}-permissions`}
        >
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
                  onClick={() => setSelected((s) => tickMany(s, toggleable, true, may))}
                >
                  {t('platform.team.dialog.selectAll')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSelected((s) => tickMany(s, toggleable, false, may))}
                >
                  {t('platform.team.dialog.clear')}
                </Button>
              </div>
              <div className="flex flex-col rounded-lg border" data-testid="team-matrix">
                <div
                  className={cn(
                    MATRIX_GRID,
                    // Pinned while the matrix scrolls; solid so rows don't show through.
                    'sticky top-0 z-20 h-9 rounded-t-lg border-b bg-card px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
                  )}
                  aria-hidden
                  data-testid="team-matrix-header"
                >
                  <span className="truncate">{t('platform.team.dialog.column.module')}</span>
                  {MATRIX_COLUMNS.map((verb) => (
                    <span
                      key={verb}
                      // One header height for every language: long words (de "Bearbeiten") shrink, then hyphenate.
                      className="text-center text-[0.625rem] leading-tight tracking-normal hyphens-auto [overflow-wrap:anywhere] sm:text-[0.6875rem]"
                      title={t(`platform.team.dialog.column.${verb}`)}
                    >
                      {t(`platform.team.dialog.column.${verb}`)}
                    </span>
                  ))}
                </div>
                <div className="flex flex-col divide-y">
                  {sections.map((section) => (
                    <MatrixSection
                      key={section.module}
                      section={section}
                      selected={selected}
                      access={access}
                      changed={changed}
                      onToggle={toggle}
                      onToggleMany={toggleMany}
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

/** Tri-state of a set of keys: none, some or all ticked. */
function tickState(
  keys: readonly string[],
  selected: ReadonlySet<string>,
): boolean | 'indeterminate' {
  const ticked = keys.filter((key) => selected.has(key)).length;
  return ticked === 0 ? false : ticked === keys.length ? true : 'indeterminate';
}

/**
 * One module of the matrix (ADR 0050): a header whose box ticks or clears every key in it, then its rows.
 */
function MatrixSection({
  section,
  selected,
  access,
  changed,
  onToggle,
  onToggleMany,
}: {
  section: MatrixSectionData;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
  onToggleMany: (keys: readonly string[], on: boolean) => void;
}) {
  const t = useT();
  const name = t(section.label);
  return (
    <div data-testid="team-matrix-section" data-section={section.module}>
      <label
        // Sticks under the column header (h-9) until the next section pushes it up; muted over card, but solid.
        className="sticky top-9 z-10 flex min-h-11 items-center gap-2 bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))] px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        data-testid="team-matrix-section-header"
      >
        <Checkbox
          checked={tickState(section.keys, selected)}
          disabled={!section.keys.some((key) => canToggle(access, key))}
          onCheckedChange={(v) => onToggleMany(section.keys, v === true)}
          aria-label={t('platform.team.dialog.wholeSection', { section: name })}
          data-testid="team-permission-section"
          data-section={section.module}
        />
        {name}
      </label>
      <div className="flex flex-col divide-y">
        {section.rows.map((row) => (
          <MatrixRow
            key={row.row}
            row={row}
            selected={selected}
            access={access}
            changed={changed}
            onToggle={onToggle}
            onToggleAll={(on) => onToggleMany(row.keys, on)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One row of the matrix: the box in front ticks or clears the whole row (only the keys you may change), then a View,
 * Create, Edit and Delete cell each, a muted dash where the row has no such key.
 */
function MatrixRow({
  row,
  selected,
  access,
  changed,
  onToggle,
  onToggleAll,
}: {
  row: MatrixRowData;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}) {
  const t = useT();
  const rowName = t(row.label);
  return (
    <div className={cn(MATRIX_GRID, 'px-3 py-1')} data-testid="team-matrix-row" data-area={row.row}>
      <label className="flex min-h-11 min-w-0 items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={tickState(row.keys, selected)}
          disabled={!row.keys.some((key) => canToggle(access, key))}
          onCheckedChange={(v) => onToggleAll(v === true)}
          aria-label={t('platform.team.dialog.wholeArea', { area: rowName })}
          data-testid="team-permission-area"
          data-area={row.row}
        />
        <span className="truncate" title={rowName}>
          {rowName}
        </span>
      </label>
      {MATRIX_COLUMNS.map((column) => {
        const cell = row.cells[column];
        return (
          <div key={column} className="flex justify-center" data-column={column}>
            {cell ? (
              <PermissionBox
                cell={cell}
                selected={selected}
                access={access}
                changed={changed}
                onToggle={onToggle}
              />
            ) : (
              <span
                className="text-sm text-muted-foreground/60"
                title={t('platform.team.dialog.noKey', {
                  column: t(`platform.team.dialog.column.${column}`),
                })}
                aria-hidden
                data-testid="team-permission-empty"
              >
                –
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One permission's box in its cell. Its full sentence is the title and accessible name; a note (the box allows more
 * than its column says, ADR 0050) shows as an info marker and is read out with the name.
 */
function PermissionBox({
  cell,
  selected,
  access,
  changed,
  onToggle,
}: {
  cell: MatrixCell;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const t = useT();
  const permission: PermissionKey = cell.key;
  const locked = !canToggle(access, permission);
  // "Grant View first": an unticked action whose row's View isn't ticked.
  const blocked = !locked && blockedByView(selected, permission);
  const name = t(permissionLabel(permission));
  const note = cell.note ? t(cell.note) : null;
  const described = [name, note, blocked ? t('platform.team.dialog.viewFirst') : null]
    .filter(Boolean)
    .join(' ');
  return (
    <label
      className={cn(
        'relative flex min-h-11 min-w-11 items-center justify-center text-sm',
        locked && 'text-muted-foreground',
      )}
      title={locked ? `${described} ${t('platform.team.dialog.locked')}` : described}
    >
      <Checkbox
        checked={selected.has(permission)}
        disabled={locked || blocked}
        onCheckedChange={(v) => onToggle(permission, v === true)}
        aria-label={described}
        data-blocked={blocked || undefined}
        data-testid="team-permission"
        data-key={permission}
      />
      {note && (
        <Info
          aria-hidden
          className="absolute right-0 bottom-1 size-3 text-muted-foreground"
          data-testid="team-permission-note"
        />
      )}
      {locked && <Lock aria-hidden className="absolute bottom-1 left-0 size-3" />}
      {changed(permission) && (
        <span
          className="absolute top-1.5 right-0.5 size-2 rounded-full bg-primary"
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
