import { Idempotent } from '../markers';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@durby/i18n';
import {
  type LabelOverride,
  type LabelOverridesQuery,
  labelOverridesQuerySchema,
  type LabelOverridesResponse,
  type LabelsQuery,
  labelsQuerySchema,
  type LabelsResponse,
  type PutLabelOverrideRequest,
  putLabelOverrideRequestSchema,
} from '@durby/shared';
import { UserDirectory } from '../auth';
import { ZodBody, ZodQuery } from '../http';
import { RequirePermission } from '../rbac';
import { TenantContext } from '../tenancy';
import { LabelsAdmin } from './labels-admin.service';
import { LabelService } from './labels.service';

/**
 * GET /api/v1/labels: the merged dictionary of the active organization. Reuses
 * `platform.settings.read`, which every system role holds (ADR 0011 §7).
 */
@Controller('labels')
export class LabelsController {
  constructor(
    private readonly labels: LabelService,
    private readonly tenantContext: TenantContext,
    private readonly users: UserDirectory,
  ) {}

  @RequirePermission('platform.settings.read')
  @Get()
  async get(@Query(new ZodQuery(labelsQuerySchema)) query: LabelsQuery): Promise<LabelsResponse> {
    const locale = query.locale ?? (await this.userLocale());
    return { locale, data: await this.labels.dictionary(locale) };
  }

  private async userLocale(): Promise<Locale> {
    const { userId } = this.tenantContext.require();
    const locale = (await this.users.findById(userId))?.locale ?? DEFAULT_LOCALE;
    return isLocale(locale) ? locale : DEFAULT_LOCALE;
  }
}

/**
 * /api/v1/label-overrides (docs/platform/labels.md → API). Idempotency-Key for the writes comes
 * with platform/idempotency (step 1.9); both are naturally idempotent.
 */
@Controller('label-overrides')
export class LabelOverridesController {
  constructor(private readonly admin: LabelsAdmin) {}

  @RequirePermission('platform.labels.manage')
  @Get()
  async list(
    @Query(new ZodQuery(labelOverridesQuerySchema)) query: LabelOverridesQuery,
  ): Promise<LabelOverridesResponse> {
    return { data: await this.admin.list(query.locale) };
  }

  @RequirePermission('platform.labels.manage')
  @Idempotent()
  @Put(':locale/:key')
  set(
    @Param('locale') locale: string,
    @Param('key') key: string,
    @Body(new ZodBody(putLabelOverrideRequestSchema)) body: PutLabelOverrideRequest,
  ): Promise<LabelOverride> {
    return this.admin.set(locale, key, body.value);
  }

  @RequirePermission('platform.labels.manage')
  @Idempotent()
  @Delete(':locale/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('locale') locale: string, @Param('key') key: string): Promise<void> {
    return this.admin.remove(locale, key);
  }
}
