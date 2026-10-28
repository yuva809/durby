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
} from '@nestjs/common';
import {
  type LocationListResponse,
  type LocationRequest,
  locationRequestSchema,
  type LocationSummary,
} from '@durby/shared';
import { ZodBody } from '../http';
import { Idempotent } from '../markers';
import { AccessService, RequirePermission } from '../rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../tenancy';
import { locationErrors } from './location-errors';
import { LocationsService } from './locations.service';

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
  async list(): Promise<LocationListResponse> {
    const scope = await this.access.locationIdsFor(READ);
    const rows = await this.db.location.findMany({
      where: scope === 'all' ? {} : { id: { in: scope } },
      select: { id: true, name: true, brandId: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: rows };
  }

  @RequirePermission(MANAGE)
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(locationRequestSchema)) body: LocationRequest,
  ): Promise<LocationSummary> {
    return this.locations.create(body.name);
  }

  @RequirePermission(MANAGE)
  @Idempotent()
  @Patch(':id')
  rename(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: locationErrors.notFound })) id: string,
    @Body(new ZodBody(locationRequestSchema)) body: LocationRequest,
  ): Promise<LocationSummary> {
    return this.locations.rename(id, body.name);
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
