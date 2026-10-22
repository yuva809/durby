import { Inject, Injectable } from '@nestjs/common';
import type { ActiveAccess, ActiveAccessLookup } from '../auth';
import { TenantContext } from '../tenancy';
import { holdsAnywhere } from './access';
import { AccessService } from './access.service';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';

/**
 * ActiveAccessLookup for platform/auth (session body, /auth/me; ADR 0007 amendment). Resolves only
 * the caller's own membership in the token's active organization: the tenant context is that
 * organization and the lookup goes through AccessService, i.e. the tenant client under RLS.
 */
@Injectable()
export class ActiveAccessProvider implements ActiveAccessLookup {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
  ) {}

  async lookup(organizationId: string, userId: string): Promise<ActiveAccess> {
    const access = await this.tenantContext.run({ tenantId: organizationId, userId }, () =>
      this.access.current(),
    );
    return {
      role:
        access.roleId === null
          ? null
          : { id: access.roleId, systemKey: access.systemRole, name: access.roleName },
      // Registry order; location-scope keys only when held for at least one location.
      permissions: Object.keys(this.registry).filter((key) => holdsAnywhere(access, key)),
    };
  }
}
