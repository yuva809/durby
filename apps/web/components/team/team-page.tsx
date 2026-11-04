'use client';

import {
  type LocationSummary,
  PERMISSIONS,
  type PermissionKey,
  type TeamInvitation,
  type TeamListResponse,
  type TeamMember,
} from '@durby/shared';
import {
  Check,
  Link2,
  MoreHorizontal,
  Pencil,
  Power,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  UserX,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import type { Session } from '../../lib/auth/session';
import { roleName } from '../../lib/rbac/roles';
import { loadTeam, setTeamMemberActive } from '../../lib/team/api';
import { teamRowActions } from '../../lib/team/matrix';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import {
  canRevokeInvitation,
  grantableRoles,
  permissionLabel,
  type UsersAccess,
  usersAccessOf,
} from '../../lib/users/access';
import { loadLocations, loadRoles, removeMember, revokeInvitation } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog';
import { RolesPage } from '../users/roles-page';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { scopeText } from '../users/scope-fields';
import { ShareLink } from './share-link';
import { StaffDialog } from './staff-dialog';

/** /settings/staff: Manage Staff (docs/platform/rbac.md → Manage Staff, ADR 0023). */
export function TeamPage() {
  const { session } = useAuth();
  if (!session) return null;
  const access = usersAccessOf(session);
  if (!access.canReadUsers) return <NoAccess title="platform.team.title" />;
  return <Team session={session} access={access} />;
}

type Status = 'all' | 'active' | 'inactive' | 'invited';
type Row =
  { kind: 'member'; member: TeamMember } | { kind: 'invitation'; invitation: TeamInvitation };

/** Visible chips before "+N". */
const CHIPS = 3;

function Team({ session, access }: { session: Session; access: UsersAccess }) {
  const t = useT();
  const { store } = useAuth();
  const org = session.activeOrganizationId;
  const [team, reload] = useResource(org, () => loadTeam(store));
  const [roles] = useResource(access.canReadRoles ? org : null, () => loadRoles(store));
  const [locations] = useResource(org, () => loadLocations(store));
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [editing, setEditing] = useState<TeamMember | 'new' | null>(null);
  const [sharing, setSharing] = useState<TeamInvitation | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [view, setView] = useState<'members' | 'roles'>('members');

  const roleList = roles.status === 'ready' ? roles.data : null;
  const locationList = locations.status === 'ready' ? locations.data : null;
  const grantable = roleList ? grantableRoles(access, roleList) : [];
  const organizationName =
    session.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';
  const dateFormat = new Intl.DateTimeFormat(session.user.locale, { dateStyle: 'medium' });

  return (
    <div className="flex flex-col gap-6">
      {access.canReadRoles && (
        <nav className="-mx-4 mb-2 border-b sm:-mx-8">
          <ul className="flex gap-1 px-4 sm:px-8">
            <li className="shrink-0">
              <button
                onClick={() => setView('members')}
                className={cn(
                  '-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap bg-none cursor-pointer',
                  view === 'members'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
                data-testid="team-tab-members"
              >
                {t('platform.team.title')}
              </button>
            </li>
            <li className="shrink-0">
              <button
                onClick={() => setView('roles')}
                className={cn(
                  '-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap bg-none cursor-pointer',
                  view === 'roles'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
                data-testid="team-tab-roles"
              >
                {t('platform.nav.roles')}
              </button>
            </li>
          </ul>
        </nav>
      )}

      {view === 'members' && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold">{t('platform.team.title')}</h1>
              <p className="text-muted-foreground">{t('platform.team.intro')}</p>
            </div>
            {access.canInvite && roleList && (
              <Button onClick={() => setEditing('new')} data-testid="team-add">
                <UserPlus aria-hidden />
                {t('platform.team.add')}
              </Button>
            )}
          </div>

      <Loaded resource={team} reload={reload}>
        {(data) => {
          const rows = filterRows(data, query, roleFilter, status);
          return (
            <>
              <Stats stats={data.stats} />
              <Card className="flex flex-col gap-3 p-3 md:flex-row">
                <div className="relative md:flex-1">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('platform.team.search')}
                    aria-label={t('platform.team.search')}
                    className="pl-9"
                    data-testid="team-search"
                  />
                </div>
                <Select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  aria-label={t('platform.team.filterRole')}
                  className="md:w-56"
                  data-testid="team-role-filter"
                >
                  <option value="">{t('platform.team.allRoles')}</option>
                  {(roleList ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {roleName(r, t)}
                    </option>
                  ))}
                </Select>
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status)}
                  aria-label={t('platform.team.filterStatus')}
                  className="md:w-48"
                  data-testid="team-status-filter"
                >
                  <option value="all">{t('platform.team.allStatuses')}</option>
                  <option value="active">{t('platform.team.status.active')}</option>
                  <option value="inactive">{t('platform.team.status.inactive')}</option>
                  <option value="invited">{t('platform.team.status.invited')}</option>
                </Select>
              </Card>

              <Card className="overflow-hidden p-0">
                <div className="border-b px-4 py-3">
                  <Badge>{t('platform.team.count', { count: String(rows.length) })}</Badge>
                </div>
                {rows.length === 0 ? (
                  <p className="px-4 py-10 text-center text-muted-foreground">
                    {t('platform.team.empty')}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm" data-testid="team-table">
                      <thead className="max-lg:sr-only">
                        <tr className="border-b text-xs tracking-wide text-muted-foreground uppercase">
                          <th className={head}>{t('platform.team.columns.staff')}</th>
                          <th className={head}>{t('platform.team.columns.contact')}</th>
                          <th className={head}>{t('platform.team.columns.role')}</th>
                          <th className={cn(head, rare)}>{t('platform.team.columns.worksIn')}</th>
                          <th className={head}>{t('platform.team.columns.permissions')}</th>
                          <th className={head}>{t('platform.team.columns.status')}</th>
                          <th className={cn(head, rare)}>
                            {t('platform.team.columns.lastActive')}
                          </th>
                          <th className={cn(head, 'text-right')}>
                            <span className="sr-only">{t('platform.team.columns.actions')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) =>
                          row.kind === 'member' ? (
                            <MemberRow
                              key={row.member.membershipId}
                              member={row.member}
                              access={access}
                              locations={locationList}
                              dateFormat={dateFormat}
                              onEdit={() => setEditing(row.member)}
                              onConfirm={setConfirm}
                            />
                          ) : (
                            <InvitationRow
                              key={row.invitation.invitationId}
                              invitation={row.invitation}
                              canRevoke={canRevokeInvitation(
                                access,
                                { ...row.invitation, id: row.invitation.invitationId },
                                roleList,
                              )}
                              canShare={access.canInvite}
                              locations={locationList}
                              dateFormat={dateFormat}
                              onShare={() => setSharing(row.invitation)}
                              onConfirm={setConfirm}
                            />
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </Loaded>
        </>
      )}

      {view === 'roles' && access.canReadRoles && <RolesPage />}

      {roleList && view === 'members' && (
        <StaffDialog
          member={editing !== null && editing !== 'new' ? editing : undefined}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          roles={roleList}
          grantable={grantable}
          locations={locationList}
          access={access}
          activeFeatures={session.activeFeatures}
          organizationName={organizationName}
          onSaved={reload}
        />
      )}

      {view === 'members' && (
      <Dialog open={sharing !== null} onOpenChange={(open) => !open && setSharing(null)}>
        <DialogContent closeLabel={t('platform.common.close')}>
          {sharing && (
            <>
              <DialogTitle>
                {t('platform.team.result.invitedTitle', { name: sharing.name ?? sharing.email })}
              </DialogTitle>
              <DialogDescription>{t('platform.team.result.newLinkNote')}</DialogDescription>
              <ShareLink invitationId={sharing.invitationId} organizationName={organizationName} />
            </>
          )}
        </DialogContent>
      </Dialog>
      )}

      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} onDone={reload} />
    </div>
  );
}

const head = 'px-4 py-3 font-medium';
/** Columns left out between lg and xl, where the table has no room for all eight (cards below lg). */
const rare = 'lg:max-xl:hidden';
const cell = 'px-4 py-3 align-middle max-lg:py-1';
const rowClass =
  'border-b last:border-b-0 max-lg:flex max-lg:flex-col max-lg:gap-1 max-lg:py-3 max-lg:relative';

function Stats({ stats }: { stats: TeamListResponse['stats'] }) {
  const t = useT();
  const items: { label: Parameters<typeof t>[0]; value: number; icon: ReactNode }[] = [
    { label: 'platform.team.stats.total', value: stats.total, icon: <Users aria-hidden /> },
    { label: 'platform.team.stats.active', value: stats.active, icon: <Check aria-hidden /> },
    { label: 'platform.team.stats.inactive', value: stats.inactive, icon: <X aria-hidden /> },
    { label: 'platform.team.stats.invited', value: stats.invited, icon: <UserPlus aria-hidden /> },
    {
      label: 'platform.team.stats.custom',
      value: stats.customPermissions,
      icon: <ShieldCheck aria-hidden />,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="team-stats">
      {items.map((item) => (
        <Card key={item.label} className="flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between text-muted-foreground [&_svg]:size-4">
            <dt className="text-xs font-medium tracking-wide uppercase">{t(item.label)}</dt>
            {item.icon}
          </div>
          <dd className="text-2xl font-semibold tabular-nums">{item.value}</dd>
        </Card>
      ))}
    </dl>
  );
}

function filterRows(data: TeamListResponse, query: string, roleId: string, status: Status): Row[] {
  const needle = query.trim().toLowerCase();
  const matches = (...values: (string | null)[]) =>
    !needle || values.some((v) => v?.toLowerCase().includes(needle));
  const members: Row[] = data.members
    .filter((m) => status === 'all' || m.status === status)
    .filter((m) => !roleId || m.role?.id === roleId)
    .filter((m) => matches(m.name, m.email, m.phone))
    .map((member) => ({ kind: 'member', member }));
  const invitations: Row[] = data.invitations
    .filter(() => status === 'all' || status === 'invited')
    .filter((i) => !roleId || i.role.id === roleId)
    .filter((i) => matches(i.name, i.email, i.phone))
    .map((invitation) => ({ kind: 'invitation', invitation }));
  return [...members, ...invitations];
}

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2)).toUpperCase();
}

function Person({ name, email, tag }: { name: string | null; email: string; tag?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary"
      >
        {initials(name, email)}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name ?? email}</span>
        {tag}
      </div>
    </div>
  );
}

function Contact({ email, phone }: { email: string; phone: string | null }) {
  return (
    <div className="flex max-w-56 min-w-0 flex-col">
      <span className="truncate">{email}</span>
      {phone && <span className="text-xs text-muted-foreground tabular-nums">{phone}</span>}
    </div>
  );
}

/** "Role defaults (N)" or the person's own changes as chips: extra keys, "No …" for removed ones. */
function PermissionChips({
  grants,
  denies,
  count,
}: {
  grants: readonly string[];
  denies: readonly string[];
  count: number;
}) {
  const t = useT();
  const known = (keys: readonly string[]) =>
    keys.filter((k): k is PermissionKey => Object.hasOwn(PERMISSIONS, k));
  if (grants.length + denies.length === 0) {
    return <Badge>{t('platform.team.roleDefaults', { count: String(count) })}</Badge>;
  }
  const chips = [
    ...known(grants).map((key) => ({ key, text: t(permissionLabel(key)), removed: false })),
    ...known(denies).map((key) => ({
      key,
      text: t('platform.team.removedChip', { permission: t(permissionLabel(key)) }),
      removed: true,
    })),
  ];
  return (
    <div className="flex flex-wrap gap-1" data-testid="team-chips">
      {chips.slice(0, CHIPS).map((chip) => (
        <Badge
          key={chip.key}
          className={cn(
            'font-semibold',
            chip.removed ? 'line-through decoration-1' : 'border-primary/40 text-foreground',
          )}
        >
          {chip.text}
        </Badge>
      ))}
      {chips.length > CHIPS && (
        <Badge>{t('platform.team.more', { count: String(chips.length - CHIPS) })}</Badge>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'inactive' | 'invited' }) {
  const t = useT();
  return (
    <Badge
      className={cn(
        'font-semibold',
        status === 'active' && 'border-primary/40 bg-primary/10 text-primary',
        status === 'invited' && 'bg-accent text-foreground',
      )}
      data-testid="team-status"
    >
      {t(`platform.team.status.${status}`)}
    </Badge>
  );
}

function MemberRow({
  member,
  access,
  locations,
  dateFormat,
  onEdit,
  onConfirm,
}: {
  member: TeamMember;
  access: UsersAccess;
  locations: readonly LocationSummary[] | null;
  dateFormat: Intl.DateTimeFormat;
  onEdit: () => void;
  onConfirm: (confirm: Confirm) => void;
}) {
  const t = useT();
  const actions = teamRowActions(access, member);
  const label = member.name ?? member.email;
  return (
    <tr
      className={cn(rowClass, member.status === 'inactive' && 'opacity-70')}
      data-testid="team-row"
    >
      <td className={cell}>
        <Person
          name={member.name}
          email={member.email}
          tag={
            actions.self ? (
              <span className="text-xs text-muted-foreground">{t('platform.team.you')}</span>
            ) : member.passwordChangePending ? (
              <span className="text-xs text-muted-foreground">
                {t('platform.team.passwordPending')}
              </span>
            ) : undefined
          }
        />
      </td>
      <td className={cell}>
        <Contact email={member.email} phone={member.phone} />
      </td>
      <td className={cell}>{member.role ? roleName(member.role, t) : '—'}</td>
      <td className={cn(cell, rare, 'max-w-56 truncate')}>{scopeText(t, member, locations)}</td>
      <td className={cell}>
        <PermissionChips
          grants={member.grants}
          denies={member.denies}
          count={member.permissions.length}
        />
      </td>
      <td className={cell}>
        <StatusBadge status={member.status} />
      </td>
      <td className={cn(cell, rare)}>
        <div className="flex flex-col">
          <span>
            {member.lastActiveAt
              ? dateFormat.format(new Date(member.lastActiveAt))
              : t('platform.team.never')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('platform.team.joined', { date: dateFormat.format(new Date(member.joinedAt)) })}
          </span>
        </div>
      </td>
      <td className={cn(cell, 'text-right max-lg:absolute max-lg:top-2 max-lg:right-0')}>
        {actions.canManage && (
          <RowMenu label={t('platform.team.actionsFor', { name: label })}>
            <DropdownMenuItem onSelect={onEdit} data-testid="team-edit">
              <Pencil aria-hidden />
              {t('platform.team.edit')}
            </DropdownMenuItem>
            {member.status === 'active' ? (
              <DropdownMenuItem
                onSelect={() => onConfirm({ kind: 'deactivate', member })}
                data-testid="team-deactivate"
              >
                <UserX aria-hidden />
                {t('platform.team.deactivate')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => onConfirm({ kind: 'reactivate', member })}
                data-testid="team-reactivate"
              >
                <Power aria-hidden />
                {t('platform.team.reactivate')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onConfirm({ kind: 'remove', member })}
              className="text-destructive"
            >
              <Trash2 aria-hidden />
              {t('platform.team.remove')}
            </DropdownMenuItem>
          </RowMenu>
        )}
      </td>
    </tr>
  );
}

function InvitationRow({
  invitation,
  canRevoke,
  canShare,
  locations,
  dateFormat,
  onShare,
  onConfirm,
}: {
  invitation: TeamInvitation;
  canRevoke: boolean;
  canShare: boolean;
  locations: readonly LocationSummary[] | null;
  dateFormat: Intl.DateTimeFormat;
  onShare: () => void;
  onConfirm: (confirm: Confirm) => void;
}) {
  const t = useT();
  return (
    <tr className={rowClass} data-testid="team-invitation-row">
      <td className={cell}>
        <Person name={invitation.name} email={invitation.email} />
      </td>
      <td className={cell}>
        <Contact email={invitation.email} phone={invitation.phone} />
      </td>
      <td className={cell}>{roleName(invitation.role, t)}</td>
      <td className={cn(cell, rare, 'max-w-56 truncate')}>{scopeText(t, invitation, locations)}</td>
      <td className={cell}>
        <PermissionChips grants={invitation.grants} denies={invitation.denies} count={0} />
      </td>
      <td className={cell}>
        <StatusBadge status="invited" />
      </td>
      <td className={cn(cell, rare, 'text-xs text-muted-foreground')}>
        {t('platform.team.expires', { date: dateFormat.format(new Date(invitation.expiresAt)) })}
      </td>
      <td className={cn(cell, 'text-right max-lg:absolute max-lg:top-2 max-lg:right-0')}>
        {(canShare || canRevoke) && (
          <RowMenu
            label={t('platform.team.actionsFor', { name: invitation.name ?? invitation.email })}
          >
            {canShare && (
              <DropdownMenuItem onSelect={onShare} data-testid="team-share">
                <Link2 aria-hidden />
                {t('platform.team.shareLink')}
              </DropdownMenuItem>
            )}
            {canRevoke && (
              <DropdownMenuItem
                onSelect={() => onConfirm({ kind: 'revoke', invitation })}
                className="text-destructive"
              >
                <Trash2 aria-hidden />
                {t('platform.team.revoke')}
              </DropdownMenuItem>
            )}
          </RowMenu>
        )}
      </td>
    </tr>
  );
}

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} data-testid="team-row-menu">
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

type Confirm =
  | { kind: 'deactivate' | 'reactivate' | 'remove'; member: TeamMember }
  | { kind: 'revoke'; invitation: TeamInvitation };

/** Deactivate (confirmed), reactivate, remove and cancel an invitation. */
function ConfirmDialog({
  confirm,
  onClose,
  onDone,
}: {
  confirm: Confirm | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirm) return null;
  const name =
    confirm.kind === 'revoke'
      ? confirm.invitation.email
      : (confirm.member.name ?? confirm.member.email);
  const texts = {
    deactivate: [
      'platform.team.deactivateTitle',
      'platform.team.deactivateDescription',
      'platform.team.deactivate',
    ],
    reactivate: ['platform.team.reactivate', null, 'platform.team.reactivate'],
    remove: [
      'platform.team.removeTitle',
      'platform.team.removeDescription',
      'platform.team.remove',
    ],
    revoke: [
      'platform.team.revokeTitle',
      'platform.team.revokeDescription',
      'platform.team.revoke',
    ],
  } as const;
  const [title, description, button] = texts[confirm.kind];

  async function run() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    const result =
      confirm.kind === 'revoke'
        ? await revokeInvitation(store, action, confirm.invitation.invitationId)
        : confirm.kind === 'remove'
          ? await removeMember(store, action, confirm.member.membershipId)
          : await setTeamMemberActive(
              store,
              action,
              confirm.member.membershipId,
              confirm.kind === 'reactivate',
            );
    setBusy(false);
    if (result.ok) {
      onDone();
      onClose();
    } else {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('platform.common.close')}>
        <DialogTitle>{t(title, { name, email: name })}</DialogTitle>
        {description && <DialogDescription>{t(description)}</DialogDescription>}
        <Notice text={error} tone="error" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('platform.common.cancel')}
          </Button>
          <Button
            variant={confirm.kind === 'reactivate' ? 'default' : 'destructive'}
            onClick={() => void run()}
            disabled={busy}
            data-testid="team-confirm"
          >
            {t(button)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
