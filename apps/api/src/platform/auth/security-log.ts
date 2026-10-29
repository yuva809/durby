import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type SecurityEvent =
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.login.locked'
  | 'auth.refresh.reuse_detected'
  | 'auth.logout'
  | 'auth.password.reset_requested'
  | 'auth.password.reset'
  | 'auth.email.verification_requested'
  | 'auth.email.verified'
  // Durby staff (ADR 0017): the platform audit log has the successful actions too.
  | 'staff.login.failed'
  | 'staff.login.locked'
  | 'staff.code.failed'
  | 'staff.logout';

export interface SecurityEventFields {
  userId?: string;
  /** A staff account (ADR 0017); never in the same event as `userId`. */
  staffId?: string;
  sessionId?: string;
  organizationId?: string | null;
  /** sha256 of the normalized email, for failures of unknown users. Never the email itself. */
  emailKey?: string;
  ip?: string;
}

/**
 * Structured security events for user-level auth actions that belong to no tenant (ADR 0008 §7).
 * Tenant-scoped actions go to audit_logs instead. Fields are ids and hashes only: never tokens,
 * passwords, emails or links.
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
