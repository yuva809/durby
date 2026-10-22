import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
import { findRouteMarkerProblems, listRoutes, RouteMarkerError } from './route-markers';

/**
 * Refuses to boot unless every controller route has exactly one access marker and every
 * @RequirePermission key is registered (CLAUDE.md rule 10, ADR 0007).
 */
@Injectable()
export class RouteMarkerCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const routes = listRoutes(this.discovery, this.scanner, this.reflector);
    const problems = findRouteMarkerProblems(routes, this.registry);
    if (problems.length > 0) throw new RouteMarkerError(problems);
  }
}
