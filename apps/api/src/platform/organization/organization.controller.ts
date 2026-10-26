import { Body, Controller, Patch } from '@nestjs/common';
import {
  type Organization,
  type UpdateOrganizationRequest,
  updateOrganizationRequestSchema,
} from '@durby/shared';
import { ZodBody } from '../http';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { RequirePermission } from '../rbac';
import { OrganizationService } from './organization.service';

/** /api/v1/organization: the token's own organization (docs/platform/web-shell.md → Organization profile). */
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  /** Naturally idempotent: the same name again writes nothing. */
  @RequirePermission('platform.org.manage')
  @Idempotent()
  @Patch()
  update(
    @Body(new ZodBody(updateOrganizationRequestSchema)) body: UpdateOrganizationRequest,
  ): Promise<Organization> {
    return this.organizations.rename(body.name);
  }
}
