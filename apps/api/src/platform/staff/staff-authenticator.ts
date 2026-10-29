import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { isStaffPermissionKey, STAFF_ROLE_PERMISSIONS } from '@durby/shared';
import type { Request } from 'express';
import { authErrors, Clock } from '../auth';
import { APP_CONFIG, type AppConfig } from '../config';
import type { StaffAuthenticatorPort } from '../rbac';
import { StaffContext } from './staff-context';
import { staffCookie } from './staff-cookies';
import { staffErrors } from './staff-errors';
import { FRESH_MS, StaffSessionsService } from './staff-sessions.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Applies `@PlatformOnly(key, { fresh })` for the global AccessGuard (ADR 0017 §3): the staff
 * session cookie only (a customer bearer token is ignored), an allowed Origin on writes, a live
 * session of an active account, the role's key, and a recent confirmation for fresh
 * routes. Fills StaffContext, never TenantContext.
 */
@Injectable()
export class StaffAuthenticator implements StaffAuthenticatorPort {
  private readonly origins: ReadonlySet<string>;

  constructor(
    private readonly sessions: StaffSessionsService,
    private readonly staffContext: StaffContext,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.origins = new Set(config.WEB_ORIGINS);
  }

  async authenticate(context: ExecutionContext, key: string, fresh: boolean): Promise<void> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin === undefined || !this.origins.has(origin)) throw authErrors.originRejected();
    }
    const token = staffCookie(req, this.config);
    const staff = token === undefined ? null : await this.sessions.authenticate(token);
    if (!staff) throw staffErrors.unauthenticated();
    this.staffContext.set(staff);

    const held: readonly string[] = STAFF_ROLE_PERMISSIONS[staff.role];
    if (!isStaffPermissionKey(key) || !held.includes(key)) throw staffErrors.permissionDenied(key);
    if (fresh && this.clock.now().getTime() - staff.authenticatedAt.getTime() > FRESH_MS) {
      throw staffErrors.reauthRequired();
    }
  }
}
