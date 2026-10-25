import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';

/**
 * The organization's structure (docs/platform/web-shell.md → Locations): the location list for
 * the member and invitation pages. Depends on tenancy and rbac.
 */
@Module({ controllers: [LocationsController] })
export class OrganizationModule {}
