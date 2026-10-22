import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AccessGuard } from './access.guard';
import { AccessService } from './access.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { defaultPermissionRegistry, PERMISSION_REGISTRY } from './permission-registry';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { RouteMarkerCheck } from './route-marker.check';
import { SystemRoles } from './system-roles';

/** Roles, permissions and route access (docs/platform/rbac.md). AccessGuard runs on every route. */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [MembersController, RolesController],
  providers: [
    AccessService,
    MembersService,
    RolesService,
    RouteMarkerCheck,
    SystemRoles,
    { provide: PERMISSION_REGISTRY, useValue: defaultPermissionRegistry },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AccessService, PERMISSION_REGISTRY, SystemRoles],
})
export class RbacModule {}
