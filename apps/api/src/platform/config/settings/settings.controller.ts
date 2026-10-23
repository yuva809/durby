import { Idempotent } from '../../idempotency/idempotent.decorator';
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
import {
  type PutSettingRequest,
  putSettingRequestSchema,
  type ResolvedSetting,
  SETTINGS,
  type SettingKey,
  type SettingScopeQuery,
  settingScopeQuerySchema,
  type SettingsResponse,
} from '@durby/shared';
import { ZodBody, ZodQuery } from '../../http';
import { AccessService, RequirePermission } from '../../rbac';
import type { ResolvedSettingValue } from './resolve';
import { SettingsAdmin } from './settings-admin.service';
import { type SettingsAt, SettingsService } from './settings.service';

const READ = 'platform.settings.read';

/**
 * /api/v1/settings (docs/platform/settings.md → API). The query is the scope: none =
 * organization, `brandId`, or `locationId`. Idempotency-Key for the writes comes with
 * platform/idempotency (step 1.9); both are naturally idempotent.
 */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly admin: SettingsAdmin,
    private readonly access: AccessService,
  ) {}

  @RequirePermission(READ)
  @Get()
  async list(
    @Query(new ZodQuery(settingScopeQuerySchema)) query: SettingScopeQuery,
  ): Promise<SettingsResponse> {
    const at = atOf(query);
    // Organization: the guard's "any location" check. Brand: all locations. Location: that one.
    if (at.locationId !== undefined) await this.access.assert(READ, { locationId: at.locationId });
    else if (at.brandId !== undefined) await this.access.assert(READ);
    const resolved = await this.settings.all(at);
    return { data: [...resolved].map(([key, value]) => toResponse(key, value)) };
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Put(':key')
  async set(
    @Param('key') key: string,
    @Query(new ZodQuery(settingScopeQuerySchema)) query: SettingScopeQuery,
    @Body(new ZodBody(putSettingRequestSchema)) body: PutSettingRequest,
  ): Promise<ResolvedSetting> {
    const resolved = await this.admin.set(key, atOf(query), body.value);
    return toResponse(key as SettingKey, resolved);
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('key') key: string,
    @Query(new ZodQuery(settingScopeQuerySchema)) query: SettingScopeQuery,
  ): Promise<void> {
    return this.admin.remove(key, atOf(query));
  }
}

function atOf(query: SettingScopeQuery): SettingsAt {
  if (query.locationId !== undefined) return { locationId: query.locationId };
  if (query.brandId !== undefined) return { brandId: query.brandId };
  return {};
}

function toResponse(key: SettingKey, resolved: ResolvedSettingValue): ResolvedSetting {
  return {
    key,
    value: resolved.value as ResolvedSetting['value'],
    source: resolved.source,
    dataBound: SETTINGS[key].dataBound,
  };
}
