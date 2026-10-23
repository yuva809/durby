import { Inject, Injectable } from '@nestjs/common';
import type { ActiveAccess, ActiveAccessLookup } from '../auth';
import {
  type ActiveEntitlementsLookup,
  EntitlementService,
  NO_ENTITLEMENTS,
  type ResolvedEntitlements,
} from '../config/entitlements';
import { TenantContext } from '../tenancy';
import { holdsAnywhere, type ResolvedAccess } from './access';
import { AccessService } from './access.service';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';

/**
 * ActiveAccessLookup for platform/auth (session body, /auth/me; ADR 0007 amendment) and
 * ActiveEntitlementsLookup for /me/entitlements (ADR 0009 §6). Resolves only the caller's own
 * membership in the token's active organization: the tenant context is that organization and the
 * lookups go through AccessService and EntitlementService, i.e. the tenant client under RLS.
 * Features only for a member of the organization.
 */
@Injectable()
export class ActiveAccessProvider implements ActiveAccessLookup, ActiveEntitlementsLookup {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly entitlements: EntitlementService,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
  ) {}

  lookup(organizationId: string, userId: string): Promise<ActiveAccess> {
    return this.asMember(organizationId, userId, (access, entitlements) => ({
      role:
        access.roleId === null
          ? null
          : { id: access.roleId, systemKey: access.systemRole, name: access.roleName },
      // Registry order; location-scope keys only when held for at least one location.
      permissions: Object.keys(this.registry).filter((key) => holdsAnywhere(access, key)),
      features: [...entitlements.features.keys()],
    }));
  }

  entitlementsOf(organizationId: string, userId: string): Promise<ResolvedEntitlements> {
    return this.asMember(organizationId, userId, (_, entitlements) => entitlements);
  }

  /** In the organization's tenant context; entitlements only when `userId` is a member. */
  private asMember<T>(
    organizationId: string,
    userId: string,
    fn: (access: ResolvedAccess, entitlements: ResolvedEntitlements) => T,
  ): Promise<T> {
    return this.tenantContext.run({ tenantId: organizationId, userId }, async () => {
      const access = await this.access.current();
      const entitlements =
        access.membershipId === null ? NO_ENTITLEMENTS : await this.entitlements.current();
      return fn(access, entitlements);
    });
  }
}
