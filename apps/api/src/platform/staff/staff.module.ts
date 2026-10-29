import { Global, Module } from '@nestjs/common';
import { PlatformAuditReader } from './platform-audit.reader';
import { PlatformAuditService } from './platform-audit.service';
import { StaffAuthController } from './staff-auth.controller';
import { StaffAuthenticator } from './staff-authenticator';
import { StaffContext } from './staff-context';
import { StaffMailer } from './staff-mailer';
import { StaffSessionsService } from './staff-sessions.service';
import { PlatformAuditController, StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Durby staff and the admin portal API (docs/platform/admin-portal.md, ADR 0017). The global
 * AccessGuard (platform/rbac) calls the StaffAuthenticator on every @PlatformOnly route.
 */
@Global()
@Module({
  controllers: [StaffAuthController, StaffController, PlatformAuditController],
  providers: [
    PlatformAuditReader,
    PlatformAuditService,
    StaffAuthenticator,
    StaffContext,
    StaffMailer,
    StaffService,
    StaffSessionsService,
  ],
  exports: [StaffAuthenticator, StaffContext, StaffService],
})
export class StaffModule {}
