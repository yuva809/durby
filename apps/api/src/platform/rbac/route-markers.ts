import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { isFeatureKey } from '@durby/shared';
import { IS_AUTHENTICATED_KEY, IS_PUBLIC_KEY } from '../auth';
import { featuresOf } from '../config/entitlements';
import { API_PREFIX } from '../http';
import { IS_PLATFORM_ONLY_KEY } from './platform-only.decorator';
import type { PermissionRegistry } from './permission-registry';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';

/** The access marker of a route (CLAUDE.md rule 10). */
export type RouteMarker =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'platformOnly' }
  | { kind: 'permission'; key: string };

type Target = object;

function markersOn(reflector: Reflector, target: Target): RouteMarker[] {
  const markers: RouteMarker[] = [];
  if (reflector.get<boolean | undefined>(IS_PUBLIC_KEY, target as never)) {
    markers.push({ kind: 'public' });
  }
  if (reflector.get<boolean | undefined>(IS_AUTHENTICATED_KEY, target as never)) {
    markers.push({ kind: 'authenticated' });
  }
  if (reflector.get<boolean | undefined>(IS_PLATFORM_ONLY_KEY, target as never)) {
    markers.push({ kind: 'platformOnly' });
  }
  const key = reflector.get<string | undefined>(REQUIRED_PERMISSION_KEY, target as never);
  if (key !== undefined) markers.push({ kind: 'permission', key });
  return markers;
}

/** Every marker on the handler and on its controller class. A valid route has exactly one. */
export function markersOf(
  reflector: Reflector,
  handler: Target,
  controller: Target,
): RouteMarker[] {
  return [...markersOn(reflector, handler), ...markersOn(reflector, controller)];
}

/** The route's single marker, or null when it has none or several (the guard then denies). */
export function markerOf(
  reflector: Reflector,
  handler: Target,
  controller: Target,
): RouteMarker | null {
  const markers = markersOf(reflector, handler, controller);
  return markers.length === 1 ? (markers[0] ?? null) : null;
}

export interface RouteInfo {
  /** e.g. `GET /api/v1/auth/me` */
  route: string;
  markers: RouteMarker[];
  /** @RequireFeature keys (an extra check, not a marker; ADR 0009). */
  features: string[];
}

/** Every controller route of the application with its markers, sorted by route. */
export function listRoutes(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { metatype } = wrapper;
    if (!metatype) continue;
    const prefix = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
    const prototype = metatype.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const full = [API_PREFIX, prefix, path].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean);
      routes.push({
        route: `${method} /${full.join('/')}`,
        markers: markersOf(reflector, handler, metatype),
        features: featuresOf(reflector, handler, metatype),
      });
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Problems that make the api refuse to boot: no marker, several, an unregistered permission or
 * feature key, or @RequireFeature on a route without @RequirePermission.
 */
export function findRouteMarkerProblems(
  routes: readonly RouteInfo[],
  registry: PermissionRegistry,
): string[] {
  const problems: string[] = [];
  for (const { route, markers, features } of routes) {
    if (markers.length === 0) {
      problems.push(`${route}: no access marker`);
    } else if (markers.length > 1) {
      problems.push(
        `${route}: ${markers.length} access markers (${markers.map(describe).join(', ')})`,
      );
    }
    for (const marker of markers) {
      if (marker.kind === 'permission' && !Object.hasOwn(registry, marker.key)) {
        problems.push(`${route}: unregistered permission key ${marker.key}`);
      }
    }
    for (const feature of features) {
      if (!isFeatureKey(feature)) problems.push(`${route}: unregistered feature key ${feature}`);
    }
    if (features.length > 0 && !markers.some((marker) => marker.kind === 'permission')) {
      problems.push(`${route}: @RequireFeature needs @RequirePermission (ADR 0009)`);
    }
  }
  return problems;
}

export class RouteMarkerError extends Error {
  constructor(problems: readonly string[]) {
    super(
      'Every route needs exactly one of @Public(), @Authenticated(), @RequirePermission(key) or ' +
        `@PlatformOnly() (CLAUDE.md rule 10, ADR 0007):\n  ${problems.join('\n  ')}`,
    );
    this.name = 'RouteMarkerError';
  }
}

const describe = (marker: RouteMarker): string =>
  marker.kind === 'permission' ? `permission ${marker.key}` : marker.kind;
