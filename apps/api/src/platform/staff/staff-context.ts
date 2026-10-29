import { Injectable } from '@nestjs/common';
import type { StaffRole } from '@durby/shared';
import { ClsService } from 'nestjs-cls';
import { staffErrors } from './staff-errors';

export interface StaffContextValue {
  staffId: string;
  sessionId: string;
  role: StaffRole;
  /** Last password confirmation of the session (sign-in or re-confirmation). */
  authenticatedAt: Date;
}

const CLS_KEY = 'durby:staff';

/**
 * The signed-in staff member of the current request, set by the AccessGuard on @PlatformOnly
 * routes from the verified session cookie. Never set together with a TenantContext.
 */
@Injectable()
export class StaffContext {
  constructor(private readonly cls: ClsService) {}

  get(): Readonly<StaffContextValue> | undefined {
    return this.cls.isActive() ? this.cls.get<StaffContextValue | undefined>(CLS_KEY) : undefined;
  }

  /** Throws 401 staff.unauthenticated outside a staff request. */
  require(): Readonly<StaffContextValue> {
    const ctx = this.get();
    if (!ctx) throw staffErrors.unauthenticated();
    return ctx;
  }

  set(ctx: StaffContextValue): void {
    this.cls.set(CLS_KEY, Object.freeze({ ...ctx }));
  }
}
