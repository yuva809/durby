import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';

/** Bootstrap provisioning (create-admin, seed-dev). Depends on platform/auth and platform/rbac. */
@Module({
  providers: [ProvisioningService],
  exports: [ProvisioningService],
})
export class ProvisioningModule {}
