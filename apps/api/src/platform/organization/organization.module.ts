import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * The organization's profile and structure (docs/platform/web-shell.md → Organization profile,
 * Locations). Depends on tenancy, rbac, audit and idempotency.
 */
@Module({
  controllers: [LocationsController, OrganizationController],
  providers: [LocationsService, OrganizationService],
})
export class OrganizationModule {}
