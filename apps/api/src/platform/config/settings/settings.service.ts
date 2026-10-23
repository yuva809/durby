import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SettingKey, SettingValue } from '@durby/shared';
import { ClsService } from 'nestjs-cls';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../tenancy';
import {
  type ResolvedSettings,
  resolveSettings,
  type SettingRows,
  type SettingTarget,
} from './resolve';
import { settingsErrors } from './settings-errors';

const CLS_KEY = 'durby:settings';

/** Where to read: organization (`{}`), a brand, or a location (and its brand). Never both ids. */
export type SettingsAt =
  | { brandId?: undefined; locationId?: undefined }
  | { brandId: string; locationId?: undefined }
  | { brandId?: undefined; locationId: string };

interface Cached {
  tenantId: string;
  rows: Promise<SettingRows>;
}

/**
 * Resolved settings of the current tenant (docs/platform/settings.md → Resolution). The tenant's
 * values and its partner's are loaded once per request (cached in the request's CLS scope), so a
 * change applies to the next request. Needs only a tenant context, so jobs use it inside
 * TenantContext.run(); without an active CLS scope nothing is cached.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly tenantContext: TenantContext,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
  ) {}

  /** One setting's value at `at`. */
  async get<K extends SettingKey>(key: K, at: SettingsAt = {}): Promise<SettingValue<K>> {
    return (await this.all(at)).get(key)?.value as SettingValue<K>;
  }

  /** Every registered key at `at`, with the level each value came from. */
  async all(at: SettingsAt = {}): Promise<ResolvedSettings> {
    const target = await this.db.$transaction((tx) => targetOf(tx, at));
    const { tenantId } = this.tenantContext.require();
    return resolveSettings(await this.rows(), target, (problem) =>
      this.logger.warn({ tenantId, problem }, 'Ignored stored setting'),
    );
  }

  /** Drops the cached values of this scope (after changing them). */
  forget(): void {
    if (this.cls.isActive()) this.cls.set(CLS_KEY, undefined);
  }

  private rows(): Promise<SettingRows> {
    const { tenantId } = this.tenantContext.require();
    const active = this.cls.isActive();
    const cached = active ? this.cls.get<Cached | undefined>(CLS_KEY) : undefined;
    if (cached && cached.tenantId === tenantId) return cached.rows;
    const rows = this.load(tenantId);
    if (active) this.cls.set<Cached>(CLS_KEY, { tenantId, rows });
    return rows;
  }

  private load(tenantId: string): Promise<SettingRows> {
    return this.db.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: tenantId },
        select: { partnerId: true },
      });
      const [partner, tenant] = [
        organization
          ? await tx.partnerSettingValue.findMany({
              where: { partnerId: organization.partnerId },
              select: { key: true, value: true },
            })
          : [],
        await tx.settingValue.findMany({
          where: { tenantId },
          select: { scopeType: true, brandId: true, locationId: true, key: true, value: true },
        }),
      ];
      return { partner, tenant };
    });
  }
}

/**
 * The brand and location of `at`, if they are the current tenant's (RLS hides others): 404
 * settings.brand_not_found / settings.location_not_found otherwise. A location brings its brand.
 */
export async function targetOf(
  tx: TenantTransactionClient,
  at: SettingsAt,
): Promise<SettingTarget> {
  if (at.locationId !== undefined) {
    const location = await tx.location.findUnique({
      where: { id: at.locationId },
      select: { brandId: true },
    });
    if (!location) throw settingsErrors.locationNotFound();
    return { brandId: location.brandId, locationId: at.locationId };
  }
  if (at.brandId !== undefined) {
    if ((await tx.brand.count({ where: { id: at.brandId } })) === 0) {
      throw settingsErrors.brandNotFound();
    }
    return { brandId: at.brandId, locationId: null };
  }
  return { brandId: null, locationId: null };
}
