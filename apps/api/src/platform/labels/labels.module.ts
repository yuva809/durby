import { Global, Module } from '@nestjs/common';
import { LabelsAdmin } from './labels-admin.service';
import { LabelOverridesController, LabelsController } from './labels.controller';
import { LabelService } from './labels.service';

/**
 * Labels and organization overrides (docs/platform/labels.md). Depends on tenancy, audit, auth and
 * rbac; code rendering on an organization's behalf takes its t() from LabelService.
 */
@Global()
@Module({
  controllers: [LabelsController, LabelOverridesController],
  providers: [LabelService, LabelsAdmin],
  exports: [LabelService],
})
export class LabelsModule {}
