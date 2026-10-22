import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AccessGuard } from './access.guard';
import { AccessService } from './access.service';
import { defaultPermissionRegistry, PERMISSION_REGISTRY } from './permission-registry';
import { RouteMarkerCheck } from './route-marker.check';

/** Roles, permissions and route access (docs/platform/rbac.md). AccessGuard runs on every route. */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    AccessService,
    RouteMarkerCheck,
    { provide: PERMISSION_REGISTRY, useValue: defaultPermissionRegistry },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AccessService, PERMISSION_REGISTRY],
})
export class RbacModule {}
