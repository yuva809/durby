import { Inject, Injectable } from '@nestjs/common';
import type { BillLayout, SettingKey, SettingValue } from '@durby/shared';
import { type ResolvedSettings, SettingsService } from '../../platform/config/settings';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';
import { posErrors } from './pos-errors';

/**
 * The printed bill's header and footer at a location (docs/modules/pos.md → Bill layout, ADR 0025):
 * the effective `pos.billHeader` and `pos.billFooter` there. For those who print bills
 * (`pos.bills.print` at that location); a location they can't print at doesn't exist for them.
 */
@Injectable()
export class BillLayoutService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
  ) {}

  async at(locationId: string): Promise<BillLayout> {
    if (!(await this.access.can('pos.bills.print', { locationId }))) {
      throw posErrors.locationNotFound();
    }
    return this.db.$transaction(async (tx) => {
      const location = await tx.location.findUnique({
        where: { id: locationId },
        select: { id: true },
      });
      if (!location) throw posErrors.locationNotFound();
      const resolved = await this.settings.all({ locationId }, tx);
      return {
        header: setting(resolved, 'pos.billHeader'),
        footer: setting(resolved, 'pos.billFooter'),
      };
    });
  }
}

/** A resolved value; every registered key resolves (code default at the latest). */
function setting<K extends SettingKey>(resolved: ResolvedSettings, key: K): SettingValue<K> {
  return resolved.get(key)?.value as SettingValue<K>;
}
