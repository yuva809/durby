import { Global, Module } from '@nestjs/common';
import { NumberingAdmin } from './numbering-admin.service';
import { NumberingController } from './numbering.controller';
import { NumberingService } from './numbering.service';

/**
 * Number series (docs/platform/numbering.md). Depends on tenancy, auth (clock), settings
 * (time zone), entitlements, rbac and audit; modules allocate through NumberingService.
 */
@Global()
@Module({
  controllers: [NumberingController],
  providers: [NumberingService, NumberingAdmin],
  exports: [NumberingService],
})
export class NumberingModule {}
