import { Injectable } from '@nestjs/common';
import type { DayClock } from '@durby/shared';
import { SettingsService } from '../../platform/config/settings';
import type { TenantTransactionClient } from '../../platform/tenancy';

/** A location, and where its business days start. */
export interface Place {
  locationId: string;
  name: string;
  clock: DayClock;
}

/** The locations the overview and the daily report are about (ADR 0082): active, no warehouse sites. */
export const ACTIVE_BRANCHES = { archivedAt: null, isWarehouseSite: false } as const;

type Where = NonNullable<
  NonNullable<Parameters<TenantTransactionClient['location']['findMany']>[0]>['where']
>;

@Injectable()
export class ReportPlaces {
  constructor(private readonly settings: SettingsService) {}

  /** By name. Who may read them is the caller's question. */
  async load(where: Where, tx: TenantTransactionClient): Promise<Place[]> {
    const locations = await tx.location.findMany({
      where,
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const places: Place[] = [];
    for (const { id, name } of locations) {
      const at = { locationId: id };
      places.push({
        locationId: id,
        name,
        clock: {
          timeZone: await this.settings.get('timezone', at, tx),
          dayStartsAt: await this.settings.get('reports.dayStartsAt', at, tx),
        },
      });
    }
    return places;
  }
}
