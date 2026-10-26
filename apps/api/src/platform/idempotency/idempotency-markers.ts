import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { API_PREFIX } from '../http';
import { markersOf, type RouteMarker } from '../rbac';
import { IDEMPOTENCY_EXEMPT_KEY, IDEMPOTENT_KEY, type IdempotentOptions } from '../markers';

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface IdempotencyRouteInfo {
  /** e.g. `PUT /api/v1/settings/:key` */
  route: string;
  method: string;
  idempotent: Required<IdempotentOptions> | undefined;
  exempt: string | undefined;
  access: RouteMarker[];
}

/** Every controller route with its idempotency and access markers, sorted by route. */
export function listIdempotencyRoutes(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
): IdempotencyRouteInfo[] {
  const routes: IdempotencyRouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { metatype } = wrapper;
    if (!metatype) continue;
    const prefix = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
    const prototype = metatype.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '';
      const full = [API_PREFIX, prefix, path].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean);
      routes.push({
        route: `${method} /${full.join('/')}`,
        method,
        idempotent: reflector.get<Required<IdempotentOptions> | undefined>(
          IDEMPOTENT_KEY,
          handler as never,
        ),
        exempt: reflector.get<string | undefined>(IDEMPOTENCY_EXEMPT_KEY, handler as never),
        access: markersOf(reflector, handler, metatype),
      });
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Problems that make the api refuse to boot (CLAUDE.md rule 8, ADR 0014 §1): a write route
 * without exactly one of @Idempotent() / @IdempotencyExempt(reason), an empty reason, either
 * marker on a read route, or @Idempotent() on a route that isn't tenant-scoped (@RequirePermission).
 */
export function findIdempotencyMarkerProblems(routes: readonly IdempotencyRouteInfo[]): string[] {
  const problems: string[] = [];
  for (const { route, method, idempotent, exempt, access } of routes) {
    const write = WRITE_METHODS.has(method);
    if (!write) {
      if (idempotent || exempt !== undefined)
        problems.push(`${route}: idempotency marker on a read route`);
      continue;
    }
    if (idempotent && exempt !== undefined) {
      problems.push(`${route}: both @Idempotent() and @IdempotencyExempt()`);
    } else if (!idempotent && exempt === undefined) {
      problems.push(`${route}: no @Idempotent() or @IdempotencyExempt(reason)`);
    }
    if (exempt !== undefined && exempt.trim() === '') {
      problems.push(`${route}: @IdempotencyExempt needs a reason`);
    }
    if (idempotent && !access.some((m) => m.kind === 'permission')) {
      problems.push(`${route}: @Idempotent() needs @RequirePermission (a tenant-scoped route)`);
    }
  }
  return problems;
}

export class IdempotencyMarkerError extends Error {
  constructor(problems: readonly string[]) {
    super(
      'Every write route needs @Idempotent() or @IdempotencyExempt(reason) (CLAUDE.md rule 8, ' +
        `ADR 0014):\n  ${problems.join('\n  ')}`,
    );
    this.name = 'IdempotencyMarkerError';
  }
}
