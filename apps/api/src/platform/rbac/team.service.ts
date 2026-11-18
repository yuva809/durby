import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CreateTeamMemberRequest,
  CreateTeamMemberResponse,
  TeamListResponse,
  TeamMember,
  UpdateTeamMemberRequest,
} from '@durby/shared';
import { DEFAULT_LOCALE, LOCALES } from '@durby/i18n';
import { auditActor, AuditService, snapshot } from '../audit';
import { AuthRateLimits, Clock, normalizeEmail, RevocationService, UserDirectory } from '../auth';
import type { Prisma } from '../database/generated/client';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { effectiveKeysOf } from './access';
import { canGrantRole, canManageMember } from './granting';
import { INVITATION_SETTINGS, type InvitationSettings } from './invitation-ports';
import { InvitationsService } from './invitations.service';
import { existingLocations } from './locations';
import { MembersService } from './members.service';
import {
  canSetOverrides,
  fromRows,
  memberView,
  NO_OVERRIDES,
  normalizeOverrides,
  type Overrides,
  toRows,
} from './overrides';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
import { isUniqueViolation, rbacErrors } from './rbac-errors';
import { ROLE_SELECT, RolesService } from './roles.service';

const MEMBER_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  allLocations: true,
  displayName: true,
  phone: true,
  deactivatedAt: true,
  createdAt: true,
  role: { select: ROLE_SELECT },
  locations: { select: { locationId: true } },
  permissions: { select: { permissionKey: true, effect: true } },
} as const;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * Manage Staff (docs/platform/rbac.md → Manage Staff, ADR 0023): the team with names, phones,
 * per-member permission changes and status; adding someone with a temporary password or an
 * invitation link; changing and (de)activating members.
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly roles: RolesService,
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
    private readonly users: UserDirectory,
    private readonly revocations: RevocationService,
    private readonly limits: AuthRateLimits,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(INVITATION_SETTINGS) private readonly settings: InvitationSettings,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
  ) {}

  /** Members (active first, then by name or email), open invitations and the counts. */
  async list(): Promise<TeamListResponse> {
    const { tenantId } = this.tenantContext.require();
    const now = this.clock.now();
    const [rows, invitations] = await Promise.all([
      this.db.membership.findMany({ select: MEMBER_SELECT }),
      this.db.invitation.findMany({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        select: {
          id: true,
          email: true,
          displayName: true,
          phone: true,
          allLocations: true,
          expiresAt: true,
          createdAt: true,
          role: { select: ROLE_SELECT },
          locations: { select: { locationId: true } },
          permissions: { select: { permissionKey: true, effect: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const ids = rows.map((r) => r.userId);
    const [profiles, lastActive, temporary, settable] = await Promise.all([
      this.users.profiles(ids),
      this.users.lastActiveIn(tenantId, ids),
      this.pendingPasswords(ids),
      this.users.passwordSettableIn(tenantId, ids),
    ]);
    const members = rows
      .map((row) =>
        this.toMember(row, {
          email: profiles.get(row.userId)?.email ?? '',
          lastActiveAt: lastActive.get(row.userId) ?? null,
          passwordChangePending: temporary.has(row.userId),
          passwordSettable: settable.has(row.userId),
        }),
      )
      .sort(
        (a, b) =>
          Number(a.status === 'inactive') - Number(b.status === 'inactive') ||
          (a.name ?? a.email).localeCompare(b.name ?? b.email),
      );
    const active = members.filter((m) => m.status === 'active').length;
    return {
      members,
      invitations: invitations.map((inv) => ({
        invitationId: inv.id,
        name: inv.displayName,
        email: inv.email,
        phone: inv.phone,
        role: { id: inv.role.id, systemKey: inv.role.systemKey, name: inv.role.name },
        allLocations: inv.allLocations,
        locationIds: inv.locations.map((l) => l.locationId).sort(),
        ...fromRows(inv.permissions),
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
      })),
      stats: {
        total: members.length,
        active,
        inactive: members.length - active,
        invited: invitations.length,
        customPermissions: members.filter((m) => m.grants.length + m.denies.length > 0).length,
      },
    };
  }

  /**
   * Adds a member. With a temporary password and no account for the email: the account and the
   * membership at once. Otherwise (no password, or the email already has an account, whose
   * password nobody else may set): an invitation, whose link is returned once (ADR 0023 §3–5).
   */
  async create(body: CreateTeamMemberRequest): Promise<CreateTeamMemberResponse> {
    const { tenantId } = this.tenantContext.require();
    await this.limits.enforce([this.limits.rules.teamCreateOrg, tenantId]);
    const email = normalizeEmail(body.email);
    const existing = await this.users.findByEmail(email);
    if (body.temporaryPassword === undefined || existing) return this.inviteInstead(body);
    try {
      return await this.createAccount(body, email, body.temporaryPassword);
    } catch (error) {
      // The email got an account between the check and the insert: invite instead.
      if (isUniqueViolation(error)) return this.inviteInstead(body);
      throw error;
    }
  }

  private async inviteInstead(body: CreateTeamMemberRequest): Promise<CreateTeamMemberResponse> {
    const result = await this.invitations.invite(
      {
        email: body.email,
        roleId: body.roleId,
        locationIds: body.locationIds ?? null,
        name: body.name,
        phone: body.phone ?? null,
        grants: body.grants,
        denies: body.denies,
        locale: body.locale ?? null,
      },
      { sendEmail: body.sendEmail },
    );
    return {
      kind: 'invited',
      invitationId: result.invitation.id,
      existingAccount: result.existingAccount,
    };
  }

  private async createAccount(
    body: CreateTeamMemberRequest,
    email: string,
    password: string,
  ): Promise<CreateTeamMemberResponse> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    const allLocations = body.locationIds == null;
    const locale = body.locale ?? (await this.settings.get('locale'));
    // Set by owners and admins (ADR 0052): the password given here is final.
    const managed = await this.settings.get('team.adminsManageSignIn');
    const membershipId = await this.db.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { tenantId_id: { tenantId, id: body.roleId } },
        select: ROLE_SELECT,
      });
      if (!role) throw rbacErrors.roleNotFound();
      if (!canGrantRole(actor, this.roles.viewOf(role))) throw rbacErrors.notGrantable();
      if (role.systemKey === 'owner' && !allLocations) throw rbacErrors.ownerAllLocations();
      const locationIds = body.locationIds ? await existingLocations(tx, body.locationIds) : [];
      const overrides = normalizeOverrides(this.registry, this.roles.viewOf(role), body);
      if (!canSetOverrides(actor, NO_OVERRIDES, overrides)) throw rbacErrors.notGrantable();
      const user = await this.users.createWithTemporaryPassword(tx, {
        email,
        password,
        temporary: !managed,
        locale: (LOCALES as readonly string[]).includes(locale) ? locale : DEFAULT_LOCALE,
        organizationId: tenantId,
      });
      const created = await tx.membership.create({
        data: {
          tenantId,
          userId: user.id,
          roleId: role.id,
          allLocations,
          displayName: body.name,
          phone: body.phone ?? null,
        },
        select: { id: true },
      });
      await this.writeScope(tx, tenantId, created.id, { locationIds, overrides });
      const row = await tx.membership.findUniqueOrThrow({
        where: { id: created.id },
        select: MEMBER_SELECT,
      });
      await this.audit.record(tx, {
        action: 'platform.membership.created',
        actor: auditActor.user(actor.userId),
        entityId: row.id,
        after: snapshotOf(row),
      });
      return row.id;
    });
    return { kind: 'created', membershipId };
  }

  /** Name, phone, role, locations and per-member changes; granting rules apply (ADR 0023 §2). */
  async update(id: string, body: UpdateTeamMemberRequest): Promise<TeamMember> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    const row = await this.members.lastOwnerGuard(() =>
      this.db.$transaction(async (tx) => {
        const target = await this.manageable(tx, tenantId, id, actor);
        let role = target.role;
        if (body.roleId !== undefined && body.roleId !== target.roleId) {
          const found = await tx.role.findUnique({
            where: { tenantId_id: { tenantId, id: body.roleId } },
            select: ROLE_SELECT,
          });
          if (!found) throw rbacErrors.roleNotFound();
          if (!canGrantRole(actor, this.roles.viewOf(found))) throw rbacErrors.notGrantable();
          role = found;
        }
        const allLocations =
          body.locationIds === undefined ? target.allLocations : body.locationIds === null;
        if (role.systemKey === 'owner' && !allLocations) throw rbacErrors.ownerAllLocations();
        const locationIds = body.locationIds ? await existingLocations(tx, body.locationIds) : [];
        const before = fromRows(target.permissions);
        // Overrides that didn't change are re-checked against a new role (no-ops are dropped).
        const overrides = normalizeOverrides(this.registry, this.roles.viewOf(role), {
          grants: body.grants ?? before.grants,
          denies: body.denies ?? before.denies,
        });
        if (!canSetOverrides(actor, before, overrides)) throw rbacErrors.notGrantable();
        if (role.id !== target.roleId && target.role.systemKey === 'owner') {
          await this.members.assertAnotherOwner(tx, target.role.id, target.id);
        }

        await tx.membership.update({
          where: { id: target.id },
          data: {
            roleId: role.id,
            allLocations,
            ...(body.name !== undefined && { displayName: body.name }),
            ...(body.phone !== undefined && { phone: body.phone }),
          },
        });
        await this.writeScope(tx, tenantId, target.id, {
          locationIds: body.locationIds === undefined ? undefined : locationIds,
          overrides,
        });
        const row = await tx.membership.findUniqueOrThrow({
          where: { id: target.id },
          select: MEMBER_SELECT,
        });
        await this.audit.record(tx, {
          action: 'platform.membership.updated',
          actor: auditActor.user(actor.userId),
          entityId: row.id,
          before: snapshotOf(target),
          after: snapshotOf(row),
        });
        return row;
      }),
    );
    return this.memberOf(row);
  }

  /**
   * Sets a member's password (ADR 0052): an account this organization created and that belongs to no other one,
   * managed by the actor (never themselves, an Owner only by an Owner). Final with `team.adminsManageSignIn` on,
   * else temporary (they choose their own at the next sign-in). Every session of the member ends; audited without
   * the password (users live outside the tenant tables, so the audit row follows the change).
   */
  async setPassword(id: string, password: string): Promise<TeamMember> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    const target = await this.db.$transaction((tx) => this.manageable(tx, tenantId, id, actor));
    const settable = await this.users.passwordSettableIn(tenantId, [target.userId]);
    if (!settable.has(target.userId)) throw rbacErrors.passwordNotSettable();
    const managed = await this.settings.get('team.adminsManageSignIn');
    const now = this.clock.now();
    await this.users.setPassword(target.userId, password, { temporary: !managed, now });
    try {
      await this.revocations.revokeUser(target.userId, now);
    } catch (error) {
      // The refresh tokens are revoked already; access tokens end within their short lifetime.
      this.logger.error(
        { err: { type: error instanceof Error ? error.name : 'unknown' } },
        'password revocation marker not written',
      );
    }
    await this.db.$transaction((tx) =>
      this.audit.record(tx, {
        action: 'platform.membership.password_set',
        actor: auditActor.user(actor.userId),
        entityId: target.id,
        after: snapshotOf(target),
      }),
    );
    return this.memberOf(target);
  }

  /** Who still has to replace a temporary password: nobody where owners and admins set passwords. */
  private async pendingPasswords(ids: readonly string[]): Promise<Set<string>> {
    if (await this.settings.get('team.adminsManageSignIn')) return new Set();
    return this.users.withTemporaryPassword(ids);
  }

  /** Switches a member off: no access, open sessions end at once (ADR 0023 §6). */
  async deactivate(id: string): Promise<TeamMember> {
    const { tenantId } = this.tenantContext.require();
    const row = await this.setActive(id, false);
    try {
      await this.revocations.revokeMembership(tenantId, row.userId, this.clock.now());
    } catch (error) {
      // Committed already, and the database denies access from the next request on.
      this.logger.error(
        { err: { type: error instanceof Error ? error.name : 'unknown' } },
        'membership revocation marker not written',
      );
    }
    return this.memberOf(row);
  }

  async reactivate(id: string): Promise<TeamMember> {
    return this.memberOf(await this.setActive(id, true));
  }

  private async setActive(id: string, active: boolean): Promise<MemberRow> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    return this.members.lastOwnerGuard(() =>
      this.db.$transaction(async (tx) => {
        const target = await this.manageable(tx, tenantId, id, actor);
        if ((target.deactivatedAt === null) === active) return target;
        if (!active && target.role.systemKey === 'owner') {
          await this.members.assertAnotherOwner(tx, target.role.id, target.id);
        }
        const row = await tx.membership.update({
          where: { id: target.id },
          data: { deactivatedAt: active ? null : this.clock.now() },
          select: MEMBER_SELECT,
        });
        await this.audit.record(tx, {
          action: active ? 'platform.membership.reactivated' : 'platform.membership.deactivated',
          actor: auditActor.user(actor.userId),
          entityId: row.id,
          before: snapshotOf(target),
          after: snapshotOf(row),
        });
        return row;
      }),
    );
  }

  /**
   * The member, if the actor may manage them: never themselves, an Owner only by an Owner, anyone
   * else only if their effective keys (role ± overrides) are a subset of the actor's.
   */
  private async manageable(
    tx: TenantTransactionClient,
    tenantId: string,
    id: string,
    actor: Awaited<ReturnType<RolesService['actor']>>,
  ): Promise<MemberRow> {
    const target = await tx.membership.findUnique({
      where: { tenantId_id: { tenantId, id } },
      select: MEMBER_SELECT,
    });
    if (!target) throw rbacErrors.memberNotFound();
    const verdict = canManageMember(actor, {
      userId: target.userId,
      role: memberView(this.registry, this.roles.viewOf(target.role), fromRows(target.permissions)),
    });
    if (verdict === 'self') throw rbacErrors.cannotChangeSelf();
    if (verdict === 'not_grantable') throw rbacErrors.notGrantable();
    return target;
  }

  /** Replaces the locations (when given) and the overrides of a membership. */
  private async writeScope(
    tx: TenantTransactionClient,
    tenantId: string,
    membershipId: string,
    scope: { locationIds: string[] | undefined; overrides: Overrides },
  ): Promise<void> {
    if (scope.locationIds !== undefined) {
      await tx.membershipLocation.deleteMany({ where: { membershipId } });
      await tx.membershipLocation.createMany({
        data: scope.locationIds.map((locationId) => ({ tenantId, membershipId, locationId })),
      });
    }
    await tx.membershipPermission.deleteMany({ where: { membershipId } });
    await tx.membershipPermission.createMany({
      data: toRows(scope.overrides).map((o) => ({ tenantId, membershipId, ...o })),
    });
  }

  private async memberOf(row: MemberRow): Promise<TeamMember> {
    const { tenantId } = this.tenantContext.require();
    const [profile, lastActive, temporary, settable] = await Promise.all([
      this.users.findById(row.userId),
      this.users.lastActiveIn(tenantId, [row.userId]),
      this.pendingPasswords([row.userId]),
      this.users.passwordSettableIn(tenantId, [row.userId]),
    ]);
    return this.toMember(row, {
      email: profile?.email ?? '',
      lastActiveAt: lastActive.get(row.userId) ?? null,
      passwordChangePending: temporary.has(row.userId),
      passwordSettable: settable.has(row.userId),
    });
  }

  private toMember(
    row: MemberRow,
    extra: {
      email: string;
      lastActiveAt: Date | null;
      passwordChangePending: boolean;
      passwordSettable: boolean;
    },
  ): TeamMember {
    const overrides = fromRows(row.permissions);
    const role = this.roles.viewOf(row.role);
    const keys = effectiveKeysOf(this.registry, role.keys, role.systemKey, row.permissions);
    return {
      membershipId: row.id,
      userId: row.userId,
      name: row.displayName,
      email: extra.email,
      phone: row.phone,
      role: { id: row.role.id, systemKey: row.role.systemKey, name: row.role.name },
      allLocations: row.allLocations,
      locationIds: row.locations.map((l) => l.locationId).sort(),
      ...overrides,
      permissions: Object.keys(this.registry).filter((key) => keys.has(key)),
      status: row.deactivatedAt === null ? 'active' : 'inactive',
      lastActiveAt: extra.lastActiveAt?.toISOString() ?? null,
      joinedAt: row.createdAt.toISOString(),
      passwordChangePending: extra.passwordChangePending,
      passwordSettable: extra.passwordSettable,
    };
  }
}

function snapshotOf(row: MemberRow) {
  return snapshot('membership', {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    allLocations: row.allLocations,
    locationIds: row.locations.map((l) => l.locationId),
    ...fromRows(row.permissions),
    active: row.deactivatedAt === null,
  });
}
