import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  type ListLocationsQuery,
  listLocationsQuerySchema,
  type LocationListResponse,
  type LocationRequest,
  locationRequestSchema,
  type LocationSummary,
  type UpdateLocationRequest,
  updateLocationRequestSchema,
} from '@durby/shared';
import { ZodBody, ZodQuery } from '../http';
import { Idempotent } from '../markers';
import { AccessService, RequirePermission } from '../rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../tenancy';
import { locationErrors } from './location-errors';
import { LOCATION_SELECT, locationResponse, LocationsService } from './locations.service';

const READ = 'platform.settings.read';
/** Owner only: the organization's structure, like its name. */
const MANAGE = 'platform.org.manage';

/**
 * /api/v1/locations (docs/platform/web-shell.md → Locations). Reading is behind the location-scope
 * `platform.settings.read` every system role holds, not a key of its own (ADR 0015 §11); a
 * location-limited member sees only their locations. Creates complete their idempotency key in the
 * transaction (rule 8); renames and deletes are naturally idempotent.
 */
@Controller('locations')
export class LocationsController {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly locations: LocationsService,
  ) {}

  @RequirePermission(READ)
  @Get()
  async list(
    @Query(new ZodQuery(listLocationsQuerySchema)) query: ListLocationsQuery,
  ): Promise<LocationListResponse> {
    const scope = await this.access.locationIdsFor(READ);
    const rows = await this.db.location.findMany({
      where: {
        ...(scope === 'all' ? {} : { id: { in: scope } }),
        // Archived branches only when asked for (the Branches page, ADR 0056).
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      select: LOCATION_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: rows.map(locationResponse) };
  }

  @RequirePermission(MANAGE)
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(locationRequestSchema)) body: LocationRequest,
  ): Promise<LocationSummary> {
    return this.locations.create(body.name, body.address);
  }

  @RequirePermission(MANAGE)
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: locationErrors.notFound })) id: string,
    @Body(new ZodBody(updateLocationRequestSchema)) body: UpdateLocationRequest,
  ): Promise<LocationSummary> {
    return this.locations.update(id, body);
  }

  @RequirePermission(MANAGE)
  @Idempotent()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: locationErrors.notFound })) id: string,
  ): Promise<void> {
    return this.locations.remove(id);
  }
}
