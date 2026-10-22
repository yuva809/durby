import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthContext, Authenticator } from '../auth';
import { TenantContextMissingError } from '../tenancy';
import { AccessService } from './access.service';
import { rbacErrors } from './rbac-errors';
import { markerOf } from './route-markers';

/**
 * The only global guard (ADR 0007). Applies the route's single access marker:
 * @Public() → anyone; otherwise the access token is verified (Authenticator), then
 * @Authenticated() → done; @PlatformOnly() → always 403 (platform staff isn't modelled yet);
 * @RequirePermission(key) → active organization and the key, resolved from the database.
 * A route without exactly one marker is denied (and fails the startup check).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: Authenticator,
    private readonly authContext: AuthContext,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const marker = markerOf(this.reflector, context.getHandler(), context.getClass());
    if (marker === null) throw rbacErrors.routeUnmarked();
    if (marker.kind === 'public') return true;

    await this.authenticator.authenticate(context);
    switch (marker.kind) {
      case 'authenticated':
        return true;
      case 'platformOnly':
        throw rbacErrors.platformOnly();
      case 'permission':
        if (this.authContext.require().organizationId === null) {
          throw new TenantContextMissingError();
        }
        if (!(await this.access.holdsAnywhere(marker.key))) {
          throw rbacErrors.permissionDenied(marker.key);
        }
        return true;
    }
  }
}
