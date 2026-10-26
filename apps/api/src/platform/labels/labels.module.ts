import { Global, Module } from '@nestjs/common';
import { INVITATION_LABELS } from '../rbac';
import { LabelsAdmin } from './labels-admin.service';
import { LabelOverridesController, LabelsController } from './labels.controller';
import { LabelService } from './labels.service';

/**
 * Labels and organization overrides (docs/platform/labels.md). Depends on tenancy, audit, auth and
 * rbac; code rendering on an organization's behalf takes its t() from LabelService (rbac's invitation mails
 * through INVITATION_LABELS, so rbac doesn't import labels).
 */
@Global()
@Module({
  controllers: [LabelsController, LabelOverridesController],
  providers: [LabelService, LabelsAdmin, { provide: INVITATION_LABELS, useExisting: LabelService }],
  exports: [LabelService, INVITATION_LABELS],
})
export class LabelsModule {}
