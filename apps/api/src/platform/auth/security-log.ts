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
  | 'auth.email.verified';

export interface SecurityEventFields {
  userId?: string;
  sessionId?: string;
  organizationId?: string | null;
  /** sha256 of the normalized email, for failures of unknown users. Never the email itself. */
  emailKey?: string;
  ip?: string;
}

/**
 * Structured security events until audit_logs exists (step 1.4 moves them there). Fields are
 * ids and hashes only: never tokens, passwords, emails or links.
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
