'use client';

import type { Invitation, LocationSummary, Member, Role } from '@durby/shared';
import { useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { Session } from '../../lib/auth/session';
import { roleName } from '../../lib/rbac/roles';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import {
  canRevokeInvitation,
  grantableRoles,
  memberActions,
  type UsersAccess,
  usersAccessOf,
} from '../../lib/users/access';
import {
  loadInvitations,
  loadLocations,
  loadMembers,
  loadRoles,
  removeMember,
  revokeInvitation,
} from '../../lib/users/api';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ConfirmAction, Loaded, NoAccess } from './common';
import { ChangeMemberDialog, InviteDialog } from './member-dialogs';
import { scopeText } from './scope-fields';

/** /settings/members (docs/platform/web-shell.md → Members tab, Invitations tab). */
export function MembersPage() {
  const { session } = useAuth();
  if (!session) return null;
  const access = usersAccessOf(session);
  if (!access.canReadUsers) return <NoAccess title="platform.nav.members" />;
  return <Members session={session} access={access} />;
}

const cell = 'py-3 pr-4 align-middle max-md:py-0';
const row = 'border-b max-md:flex max-md:flex-col max-md:gap-1 max-md:py-3';

function Members({ session, access }: { session: Session; access: UsersAccess }) {
  const t = useT();
  const { store } = useAuth();
  const org = session.activeOrganizationId;
  const [members, reloadMembers] = useResource(org, () => loadMembers(store));
  const [invitations, reloadInvitations] = useResource(org, () => loadInvitations(store));
  const [roles] = useResource(access.canReadRoles ? org : null, () => loadRoles(store));
  const [locations] = useResource(org, () => loadLocations(store));
  const [sent, setSent] = useState<string | null>(null);

  // Without the role list nothing can be granted or compared, so no actions are offered.
  const roleList = roles.status === 'ready' ? roles.data : null;
  const locationList = locations.status === 'ready' ? locations.data : null;
  const grantable = roleList ? grantableRoles(access, roleList) : [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.members')}</h1>
      <Tabs defaultValue="members" className="flex flex-col gap-4">
        <TabsList aria-label={t('platform.nav.members')} className="self-start">
          <TabsTrigger value="members" data-testid="tab-members">
            {t('platform.members.tab')}
          </TabsTrigger>
          <TabsTrigger value="invitations" data-testid="tab-invitations">
            {t('platform.invitations.tab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          <Loaded resource={members} reload={reloadMembers}>
            {(list) => (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="members">
                  <thead className="max-md:sr-only">
                    <tr className="border-b text-muted-foreground">
                      <th className={cell}>{t('platform.members.columns.email')}</th>
                      <th className={cell}>{t('platform.members.columns.role')}</th>
                      <th className={cell}>{t('platform.members.columns.scope')}</th>
                      <th className={cell}>
                        <span className="sr-only">{t('platform.members.columns.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((member) => (
                      <MemberRow
                        key={member.id}
                        member={member}
                        access={access}
                        roles={roleList}
                        grantable={grantable}
                        locations={locationList}
                        onChanged={reloadMembers}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Loaded>
        </TabsContent>

        <TabsContent value="invitations" className="flex flex-col gap-4">
          {access.canInvite && roleList && (
            <div className="flex flex-col items-start gap-2">
              <InviteDialog
                roles={grantable}
                locations={locationList}
                onSent={(email) => {
                  setSent(email);
                  reloadInvitations();
                }}
              />
              <Notice
                text={sent ? t('platform.invitations.sent', { email: sent }) : null}
                tone="info"
              />
            </div>
          )}
          <Loaded resource={invitations} reload={reloadInvitations}>
            {(list) =>
              list.length === 0 ? (
                <p className="text-muted-foreground">{t('platform.invitations.empty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm" data-testid="invitations">
                    <thead className="max-md:sr-only">
                      <tr className="border-b text-muted-foreground">
                        <th className={cell}>{t('platform.members.columns.email')}</th>
                        <th className={cell}>{t('platform.members.columns.role')}</th>
                        <th className={cell}>{t('platform.members.columns.scope')}</th>
                        <th className={cell}>{t('platform.invitations.columns.expires')}</th>
                        <th className={cell}>
                          <span className="sr-only">{t('platform.members.columns.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((invitation) => (
                        <InvitationRow
                          key={invitation.id}
                          invitation={invitation}
                          canRevoke={canRevokeInvitation(access, invitation, roleList)}
                          locations={locationList}
                          locale={session.user.locale}
                          onChanged={reloadInvitations}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Loaded>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MemberRow({
  member,
  access,
  roles,
  grantable,
  locations,
  onChanged,
}: {
  member: Member;
  access: UsersAccess;
  roles: readonly Role[] | null;
  grantable: readonly Role[];
  locations: readonly LocationSummary[] | null;
  onChanged: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const removal = useActionKey();
  const actions = memberActions(access, member, roles);
  return (
    <tr className={row} data-testid="member-row" data-email={member.email}>
      <td className={`${cell} font-medium`}>
        <span className="break-all">{member.email}</span>
        {actions.self && <Badge className="ml-2">{t('platform.members.you')}</Badge>}
      </td>
      <td className={cell} data-testid="member-role">
        {member.role ? roleName(member.role, t) : t('platform.members.noRole')}
      </td>
      <td className={cell}>{scopeText(t, member, locations)}</td>
      <td className={cell}>
        <div className="flex flex-wrap gap-2 md:justify-end">
          {actions.canChange && (
            <ChangeMemberDialog
              member={member}
              roles={grantable}
              locations={locations}
              onDone={onChanged}
            />
          )}
          {actions.canRemove && (
            <ConfirmAction
              testId="member-remove"
              trigger={t('platform.members.remove')}
              title={t('platform.members.removeTitle')}
              description={t('platform.members.removeDescription', { email: member.email })}
              confirm={t('platform.members.remove')}
              run={() => removeMember(store, removal, member.id)}
              onDone={onChanged}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

function InvitationRow({
  invitation,
  canRevoke,
  locations,
  locale,
  onChanged,
}: {
  invitation: Invitation;
  canRevoke: boolean;
  locations: readonly LocationSummary[] | null;
  locale: string;
  onChanged: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const revoke = useActionKey();
  const expires = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(invitation.expiresAt),
  );
  return (
    <tr className={row} data-testid="invitation-row" data-email={invitation.email}>
      <td className={`${cell} font-medium`}>
        <span className="break-all">{invitation.email}</span>
      </td>
      <td className={cell}>{roleName(invitation.role, t)}</td>
      <td className={cell}>{scopeText(t, invitation, locations)}</td>
      <td className={cell}>{t('platform.invitations.expires', { date: expires })}</td>
      <td className={cell}>
        <div className="flex flex-wrap gap-2 md:justify-end">
          {canRevoke && (
            <ConfirmAction
              testId="invitation-revoke"
              trigger={t('platform.invitations.revoke')}
              title={t('platform.invitations.revokeTitle')}
              description={t('platform.invitations.revokeDescription', {
                email: invitation.email,
              })}
              confirm={t('platform.invitations.revoke')}
              run={() => revokeInvitation(store, revoke, invitation.id)}
              onDone={onChanged}
            />
          )}
        </div>
      </td>
    </tr>
  );
}
