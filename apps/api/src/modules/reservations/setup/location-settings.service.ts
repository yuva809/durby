import { Inject, Injectable } from '@nestjs/common';
import {
  RESERVATION_LOCATION_SETTING_KEYS,
  type ReservationSettingsResponse,
  type ResolvedSetting,
  SETTINGS,
  type SettingKey,
  type WeeklyHours,
} from '@durby/shared';
import {
  type ResolvedSettingValue,
  SettingsAdmin,
  SettingsService,
} from '../../../platform/config/settings';
import { AccessService } from '../../../platform/rbac';
import { asTenantDb, TENANT_PRISMA, type TenantPrismaClient } from '../../../platform/tenancy';
import { readableLocation } from './table-rules.service';

const SETUP = 'reservations.setup.edit';

/**
 * The location's own reservations.* settings (docs/modules/reservations.md → R1.5c, ADR 0020):
 * read and written under reservations.setup.manage at the location, through the platform's
 * SettingsAdmin with the delegated key (same validation, audit and events as the settings api).
 */
@Injectable()
export class LocationSettingsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly admin: SettingsAdmin,
  ) {}

  async list(locationId: string): Promise<ReservationSettingsResponse> {
    await this.manageable(locationId);
    const resolved = await this.settings.all({ locationId });
    return {
      data: RESERVATION_LOCATION_SETTING_KEYS.map((key) =>
        toResponse(key, resolved.get(key) as ResolvedSettingValue),
      ),
      openingHours: resolved.get('openingHours')?.value as WeeklyHours,
    };
  }

  async set(key: SettingKey, locationId: string, value: unknown): Promise<ResolvedSetting> {
    await this.manageable(locationId);
    return toResponse(key, await this.admin.set(key, { locationId }, value, { permission: SETUP }));
  }

  async inherit(key: SettingKey, locationId: string): Promise<void> {
    await this.manageable(locationId);
    await this.admin.remove(key, { locationId }, { permission: SETUP });
  }

  /** 404 where the caller can't read bookings (or no such location), 403 where they can't set up. */
  private async manageable(locationId: string): Promise<void> {
    await readableLocation(asTenantDb(this.db), this.access, locationId);
    await this.access.assert(SETUP, { locationId });
  }
}

function toResponse(key: SettingKey, resolved: ResolvedSettingValue): ResolvedSetting {
  return {
    key,
    value: resolved.value as ResolvedSetting['value'],
    source: resolved.source,
    dataBound: SETTINGS[key].dataBound,
  };
}
