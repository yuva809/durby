import { Controller, Get, Inject } from '@nestjs/common';
import type { LocationListResponse } from '@durby/shared';
import { AccessService, RequirePermission } from '../rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../tenancy';

const READ = 'platform.settings.read';

/**
 * GET /api/v1/locations (docs/platform/web-shell.md → Locations). Behind the location-scope
 * `platform.settings.read` every system role holds, not a key of its own (ADR 0015 §11); a
 * location-limited member sees only their locations.
 */
@Controller('locations')
export class LocationsController {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
  ) {}

  @RequirePermission(READ)
  @Get()
  async list(): Promise<LocationListResponse> {
    const scope = await this.access.locationIdsFor(READ);
    const rows = await this.db.location.findMany({
      where: scope === 'all' ? {} : { id: { in: scope } },
      select: { id: true, name: true, brandId: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: rows };
  }
}
