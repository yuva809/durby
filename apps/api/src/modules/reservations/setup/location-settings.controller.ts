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
  type ReservationSettingsQuery,
  reservationSettingKeySchema,
  reservationSettingsQuerySchema,
  type ReservationSettingsResponse,
  type ResolvedSetting,
  type SettingKey,
} from '@durby/shared';
import { RequireFeature } from '../../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../../platform/http';
import { Idempotent } from '../../../platform/idempotency';
import { RequirePermission } from '../../../platform/rbac';
import { LocationSettingsService } from './location-settings.service';

/**
 * The location's reservations settings (docs/modules/reservations.md → R1.5c, ADR 0020). `:key` is
 * one of RESERVATION_LOCATION_SETTING_KEYS; every other key stays on the settings api.
 */
@RequireFeature('reservations')
@Controller('reservations/settings')
export class LocationSettingsController {
  constructor(private readonly settings: LocationSettingsService) {}

  @RequirePermission('reservations.setup.manage')
  @Get()
  list(
    @Query(new ZodQuery(reservationSettingsQuerySchema)) query: ReservationSettingsQuery,
  ): Promise<ReservationSettingsResponse> {
    return this.settings.list(query.locationId);
  }

  @RequirePermission('reservations.setup.manage')
  @Idempotent()
  @Put(':key')
  set(
    @Param('key', new ZodQuery(reservationSettingKeySchema)) key: SettingKey,
    @Query(new ZodQuery(reservationSettingsQuerySchema)) query: ReservationSettingsQuery,
    @Body(new ZodBody(putSettingRequestSchema)) body: PutSettingRequest,
  ): Promise<ResolvedSetting> {
    return this.settings.set(key, query.locationId, body.value);
  }

  @RequirePermission('reservations.setup.manage')
  @Idempotent()
  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  inherit(
    @Param('key', new ZodQuery(reservationSettingKeySchema)) key: SettingKey,
    @Query(new ZodQuery(reservationSettingsQuerySchema)) query: ReservationSettingsQuery,
  ): Promise<void> {
    return this.settings.inherit(key, query.locationId);
  }
}
