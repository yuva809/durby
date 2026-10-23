import { Global, Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { EntitlementsAdmin } from './entitlements-admin.service';
import { EntitlementsController } from './entitlements.controller';

/**
 * Feature entitlements (docs/platform/entitlements.md). Depends on tenancy, audit and auth; the
 * guard (platform/rbac) checks @RequireFeature and provides ACTIVE_ENTITLEMENTS_LOOKUP.
 */
@Global()
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementService, EntitlementsAdmin],
  exports: [EntitlementService, EntitlementsAdmin],
})
export class EntitlementsModule {}
