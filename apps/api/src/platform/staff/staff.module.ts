import { Global, Module } from '@nestjs/common';
import { ProvisioningModule } from '../provisioning';
import { STAFF_AUTHENTICATOR } from '../rbac';
import {
  CustomerEntitlementsController,
  FeatureCatalogController,
} from './customer-entitlements.controller';
import { CustomerEntitlementsService } from './customer-entitlements.service';
import { CustomersController, OnboardingOptionsController } from './customers.controller';
import { CustomersService } from './customers.service';
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
  imports: [ProvisioningModule],
  controllers: [
    StaffAuthController,
    StaffController,
    PlatformAuditController,
    CustomersController,
    OnboardingOptionsController,
    CustomerEntitlementsController,
    FeatureCatalogController,
  ],
  providers: [
    CustomerEntitlementsService,
    CustomersService,
    PlatformAuditReader,
    PlatformAuditService,
    StaffAuthenticator,
    StaffContext,
    StaffMailer,
    StaffService,
    StaffSessionsService,
    { provide: STAFF_AUTHENTICATOR, useExisting: StaffAuthenticator },
  ],
  exports: [STAFF_AUTHENTICATOR, StaffAuthenticator, StaffContext, StaffService],
})
export class StaffModule {}
