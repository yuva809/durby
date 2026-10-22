import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Member, UpdateMemberRequest } from '@durby/shared';
import { Clock, RevocationService, SecurityLog, UserDirectory } from '../auth';
import type { Prisma } from '../database/generated/client';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { canGrantRole, canManageMember } from './granting';
import { existingLocations } from './locations';
import { isLastOwnerViolation, rbacErrors } from './rbac-errors';
import { ROLE_SELECT, RolesService } from './roles.service';

const MEMBER_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  allLocations: true,
  role: { select: ROLE_SELECT },
  locations: { select: { locationId: true } },
} as const;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * Members of the active organization: list, change role or locations, remove
 * (docs/platform/rbac.md → Granting rules, Ending access).
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly roles: RolesService,
    private readonly users: UserDirectory,
    private readonly revocations: RevocationService,
    private readonly security: SecurityLog,
    private readonly clock: Clock,
  ) {}

  /** Members by email. */
  async list(): Promise<Member[]> {
    const rows = await this.db.membership.findMany({ select: MEMBER_SELECT });
    const profiles = await this.users.profiles(rows.map((r) => r.userId));
    return rows
      .map((row) => this.toMember(row, profiles.get(row.userId)?.email ?? ''))
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  async update(id: string, body: UpdateMemberRequest): Promise<Member> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    const { row, previousRoleId, roleChanged } = await this.lastOwnerGuard(() =>
      this.db.$transaction(async (tx) => {
        const target = await this.manageable(tx, tenantId, id, actor);

        let role = target.role;
        if (body.roleId !== undefined && body.roleId !== target.roleId) {
          role = await tx.role.findUnique({
            where: { tenantId_id: { tenantId, id: body.roleId } },
            select: ROLE_SELECT,
          });
          if (!role) throw rbacErrors.roleNotFound();
          if (!canGrantRole(actor, this.roles.viewOf(role))) throw rbacErrors.notGrantable();
        }
        const allLocations =
          body.locationIds === undefined ? target.allLocations : body.locationIds === null;
        if (role?.systemKey === 'owner' && !allLocations) throw rbacErrors.ownerAllLocations();
        const locationIds = body.locationIds ? await existingLocations(tx, body.locationIds) : [];

        const roleChanged = (role?.id ?? null) !== target.roleId;
        if (roleChanged && target.role?.systemKey === 'owner') {
          await this.assertAnotherOwner(tx, target.role.id, target.id);
        }
        await tx.membership.update({
          where: { id: target.id },
          data: { roleId: role?.id ?? null, allLocations },
        });
        if (body.locationIds !== undefined) {
          await tx.membershipLocation.deleteMany({ where: { membershipId: target.id } });
          await tx.membershipLocation.createMany({
            data: locationIds.map((locationId) => ({
              tenantId,
              membershipId: target.id,
              locationId,
            })),
          });
        }
        const row = await tx.membership.findUniqueOrThrow({
          where: { id: target.id },
          select: MEMBER_SELECT,
        });
        return { row, previousRoleId: target.roleId, roleChanged };
      }),
    );

    const fields = {
      userId: actor.userId,
      organizationId: tenantId,
      membershipId: row.id,
      targetUserId: row.userId,
    };
    if (roleChanged) {
      this.security.event('rbac.membership.role_changed', {
        ...fields,
        roleId: row.roleId ?? undefined,
        previousRoleId,
      });
    }
    if (body.locationIds !== undefined)
      this.security.event('rbac.membership.locations_changed', fields);
    const profile = await this.users.findById(row.userId);
    return this.toMember(row, profile?.email ?? '');
  }

  /**
   * Removes the membership. Access ends at once: permissions are resolved per request, and the
   * user's access tokens for this organization are revoked (auth:revoked:org).
   */
  async remove(id: string): Promise<void> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    const target = await this.lastOwnerGuard(() =>
      this.db.$transaction(async (tx) => {
        const target = await this.manageable(tx, tenantId, id, actor);
        if (target.role?.systemKey === 'owner') {
          await this.assertAnotherOwner(tx, target.role.id, target.id);
        }
        await tx.membership.delete({ where: { id: target.id } });
        return target;
      }),
    );
    try {
      await this.revocations.revokeMembership(tenantId, target.userId, this.clock.now());
    } catch (error) {
      // Committed already, and the database denies access from the next request on.
      this.logger.error(
        { err: { type: error instanceof Error ? error.name : 'unknown' } },
        'membership revocation marker not written',
      );
    }
    this.security.event('rbac.membership.removed', {
      userId: actor.userId,
      organizationId: tenantId,
      membershipId: target.id,
      targetUserId: target.userId,
      previousRoleId: target.roleId,
    });
  }

  /** The member, if the actor may change or remove them (404 / 403 otherwise). */
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
      role: target.role ? this.roles.viewOf(target.role) : null,
    });
    if (verdict === 'self') throw rbacErrors.cannotChangeSelf();
    if (verdict === 'not_grantable') throw rbacErrors.notGrantable();
    return target;
  }

  /**
   * 409 unless another Owner remains. Locks the Owner role row first, so concurrent changes to
   * Owners serialize and this count sees the other's committed result (the trigger takes the
   * same lock at commit).
   */
  private async assertAnotherOwner(
    tx: TenantTransactionClient,
    ownerRoleId: string,
    membershipId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM roles WHERE id = ${ownerRoleId}::uuid FOR UPDATE`;
    const others = await tx.membership.count({
      where: { roleId: ownerRoleId, id: { not: membershipId } },
    });
    if (others === 0) throw rbacErrors.lastOwner();
  }

  private async lastOwnerGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isLastOwnerViolation(error)) throw rbacErrors.lastOwner();
      throw error;
    }
  }

  private toMember(row: MemberRow, email: string): Member {
    return {
      id: row.id,
      userId: row.userId,
      email,
      role: row.role
        ? { id: row.role.id, systemKey: row.role.systemKey, name: row.role.name }
        : null,
      allLocations: row.allLocations,
      locationIds: row.locations.map((l) => l.locationId).sort(),
    };
  }
}
