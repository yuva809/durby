import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateRoleRequest,
  type Role,
  SYSTEM_ROLE_FEATURES,
  SYSTEM_ROLES,
  type SystemRole,
  type UpdateRoleRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../audit';
import { AuthContext, Clock } from '../auth';
import { EntitlementService } from '../config/entitlements';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';
import { storedRoleKeys } from './access';
import { AccessService } from './access.service';
import { type Actor, canEditRole, type RoleView } from './granting';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
import { isUniqueViolation, rbacErrors } from './rbac-errors';

interface RoleRow {
  id: string;
  systemKey: SystemRole | null;
  name: string | null;
  permissions: readonly { permissionKey: string }[];
}

export const ROLE_SELECT = {
  id: true,
  systemKey: true,
  name: true,
  permissions: { select: { permissionKey: true } },
} as const;

/** Roles of the active organization (docs/platform/rbac.md → Endpoints). */
@Injectable()
export class RolesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly auth: AuthContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly entitlements: EntitlementService,
  ) {}

  /**
   * The role's system key and effective registered keys, for the granting rules. Stored legacy keys are expanded
   * like access resolution does (ADR 0037 §5, ADR 0051), so a role compares by what its members can really do.
   */
  viewOf(role: RoleRow): RoleView {
    return {
      systemKey: role.systemKey,
      keys: storedRoleKeys(
        this.registry,
        role.systemKey,
        role.permissions.map((p) => p.permissionKey),
      ),
    };
  }

  toResponse(role: RoleRow): Role {
    const keys = this.viewOf(role).keys;
    return {
      id: role.id,
      systemKey: role.systemKey,
      name: role.name,
      // Registry order, so the list is stable.
      permissions: Object.keys(this.registry).filter((key) => keys.has(key)),
    };
  }

  /** The audit snapshot of a role: its effective permission keys, like the API shows them. */
  snapshotOf(role: RoleRow) {
    return snapshot('role', { ...this.toResponse(role) });
  }

  async actor(): Promise<Actor> {
    return { userId: this.auth.require().userId, access: await this.access.current() };
  }

  /**
   * System roles first (owner → staff), then custom roles by name. Roles of a module the organization doesn't have
   * (the branch roles without orders, ADR 0045) are left out.
   */
  async list(): Promise<Role[]> {
    const all = await this.db.role.findMany({ select: ROLE_SELECT });
    const needed = [...new Set(Object.values(SYSTEM_ROLE_FEATURES))];
    const enabled = new Set<string>();
    for (const feature of needed)
      if (await this.entitlements.isEnabled(feature)) enabled.add(feature);
    const roles = all.filter((r) => {
      const feature = r.systemKey ? SYSTEM_ROLE_FEATURES[r.systemKey] : undefined;
      return feature === undefined || enabled.has(feature);
    });
    const rank = (r: RoleRow) =>
      r.systemKey ? SYSTEM_ROLES.indexOf(r.systemKey) : SYSTEM_ROLES.length;
    return roles
      .sort((a, b) => rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? ''))
      .map((role) => this.toResponse(role));
  }

  async create(body: CreateRoleRequest): Promise<Role> {
    const keys = this.registeredKeys(body.permissions);
    const actor = await this.actor();
    if (!canEditRole(actor, new Set(), keys)) throw rbacErrors.notGrantable();
    const { tenantId } = this.tenantContext.require();
    const role = await this.uniqueName(() =>
      this.db.$transaction(async (tx) => {
        const created = await tx.role.create({ data: { tenantId, name: body.name } });
        await tx.rolePermission.createMany({
          data: [...keys].map((permissionKey) => ({ tenantId, roleId: created.id, permissionKey })),
        });
        const role = await tx.role.findUniqueOrThrow({
          where: { id: created.id },
          select: ROLE_SELECT,
        });
        await this.audit.record(tx, {
          action: 'platform.role.created',
          actor: auditActor.user(actor.userId),
          entityId: role.id,
          after: this.snapshotOf(role),
        });
        return role;
      }),
    );
    return this.toResponse(role);
  }

  async update(id: string, body: UpdateRoleRequest): Promise<Role> {
    const after =
      body.permissions === undefined ? undefined : this.registeredKeys(body.permissions);
    const actor = await this.actor();
    const { tenantId } = this.tenantContext.require();
    const role = await this.uniqueName(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.role.findUnique({
          where: { tenantId_id: { tenantId, id } },
          select: ROLE_SELECT,
        });
        if (!current) throw rbacErrors.roleNotFound();
        if (current.systemKey !== null) throw rbacErrors.systemRoleImmutable();
        const before = this.viewOf(current).keys;
        if (!canEditRole(actor, before, after ?? before)) throw rbacErrors.notGrantable();
        if (body.name !== undefined) {
          await tx.role.update({ where: { id }, data: { name: body.name } });
        }
        if (after !== undefined) {
          await tx.rolePermission.deleteMany({ where: { roleId: id } });
          await tx.rolePermission.createMany({
            data: [...after].map((permissionKey) => ({ tenantId, roleId: id, permissionKey })),
          });
          // Keeps updated_at meaningful when only the permissions changed.
          await tx.role.update({ where: { id }, data: { updatedAt: this.clock.now() } });
        }
        const updated = await tx.role.findUniqueOrThrow({ where: { id }, select: ROLE_SELECT });
        await this.audit.record(tx, {
          action: 'platform.role.updated',
          actor: auditActor.user(actor.userId),
          entityId: id,
          before: this.snapshotOf(current),
          after: this.snapshotOf(updated),
        });
        return updated;
      }),
    );
    return this.toResponse(role);
  }

  /** Custom roles only. Closed invitations for the role are removed; open ones block. */
  async remove(id: string): Promise<void> {
    const actor = await this.actor();
    const { tenantId } = this.tenantContext.require();
    const now = this.clock.now();
    await this.db.$transaction(async (tx) => {
      const current = await tx.role.findUnique({
        where: { tenantId_id: { tenantId, id } },
        select: ROLE_SELECT,
      });
      if (!current) throw rbacErrors.roleNotFound();
      if (current.systemKey !== null) throw rbacErrors.systemRoleImmutable();
      if (!canEditRole(actor, this.viewOf(current).keys, new Set())) {
        throw rbacErrors.notGrantable();
      }
      const [members, openInvitations] = await Promise.all([
        tx.membership.count({ where: { roleId: id } }),
        tx.invitation.count({
          where: { roleId: id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        }),
      ]);
      if (members > 0 || openInvitations > 0) throw rbacErrors.roleInUse();
      await tx.invitation.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'platform.role.deleted',
        actor: auditActor.user(actor.userId),
        entityId: id,
        before: this.snapshotOf(current),
      });
    });
  }

  private registeredKeys(keys: readonly string[]): ReadonlySet<string> {
    const unknown = [...new Set(keys)].filter((key) => !Object.hasOwn(this.registry, key));
    if (unknown.length > 0) throw rbacErrors.permissionUnknown(unknown);
    return new Set(keys);
  }

  private async uniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw rbacErrors.roleNameTaken();
      throw error;
    }
  }
}
