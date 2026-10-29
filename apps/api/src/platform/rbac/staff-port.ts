import type { ExecutionContext } from '@nestjs/common';

/**
 * What the AccessGuard needs for @PlatformOnly routes, declared here and provided by platform/staff
 * (like INVITATION_LABELS): staff uses rbac's system roles to onboard customers, so rbac importing
 * staff would be an import cycle (docs/reviews/phase-1.md → R2).
 */
export const STAFF_AUTHENTICATOR = Symbol('STAFF_AUTHENTICATOR');

export interface StaffAuthenticatorPort {
  /** Throws unless the request carries a live staff session whose role holds `key` (ADR 0017 §3). */
  authenticate(context: ExecutionContext, key: string, fresh: boolean): Promise<void>;
}
