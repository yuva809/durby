import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * The organization's profile and structure (docs/platform/web-shell.md → Organization profile,
 * Locations). Depends on tenancy, rbac and audit.
 */
@Module({
  controllers: [LocationsController, OrganizationController],
  providers: [OrganizationService],
})
export class OrganizationModule {}
