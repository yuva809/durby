import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type SecurityEvent =
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.login.locked'
  | 'auth.refresh.reuse_detected'
  | 'auth.logout'
  | 'auth.organization.switched'
  | 'auth.password.reset_requested'
  | 'auth.password.reset'
  | 'auth.email.verification_requested'
  | 'auth.email.verified'
  | 'rbac.role.created'
  | 'rbac.role.updated'
  | 'rbac.role.deleted'
  | 'rbac.membership.role_changed'
  | 'rbac.membership.locations_changed'
  | 'rbac.membership.removed'
  | 'rbac.invitation.created'
  | 'rbac.invitation.revoked'
  | 'rbac.invitation.accepted';

export interface SecurityEventFields {
  userId?: string;
  sessionId?: string;
  organizationId?: string | null;
  /** sha256 of the normalized email, for failures of unknown users. Never the email itself. */
  emailKey?: string;
  ip?: string;
  /** RBAC events: the affected user, membership, role, invitation. Ids only. */
  targetUserId?: string;
  membershipId?: string;
  roleId?: string;
  previousRoleId?: string | null;
  invitationId?: string;
}

/**
 * Structured security events until audit_logs exists (step 1.4 moves them there). For rbac events
 * `userId` is the actor. Fields are ids and hashes only: never tokens, passwords, emails or links.
 */
@Injectable()
export class SecurityLog {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('security');
  }

  event(event: SecurityEvent, fields: SecurityEventFields): void {
    this.logger.info({ security: event, ...fields }, event);
  }
}
