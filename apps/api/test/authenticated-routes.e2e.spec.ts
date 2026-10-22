import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { IS_AUTHENTICATED_KEY, IS_PUBLIC_KEY } from '../src/platform/auth';

interface Route {
  route: string;
  marker: 'public' | 'authenticated' | 'none';
}

async function listRoutes(): Promise<Route[]> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  const discovery = moduleRef.get(DiscoveryService);
  const scanner = moduleRef.get(MetadataScanner);
  const reflector = moduleRef.get(Reflector);
  const routes: Route[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | undefined;
    const { metatype } = wrapper;
    if (!instance || !metatype) continue;
    const prefix = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const targets = [handler, metatype] as Parameters<Reflector['getAllAndOverride']>[1];
      const marker = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)
        ? 'public'
        : reflector.getAllAndOverride<boolean>(IS_AUTHENTICATED_KEY, targets)
          ? 'authenticated'
          : 'none';
      const full = ['/api/v1', prefix, path].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean);
      routes.push({ route: `${method} /${full.join('/')}`, marker });
    }
  }
  await moduleRef.close();
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * CLAUDE.md rule 10 / ADR 0006: @Authenticated() is only for user-level routes that never touch
 * tenant data. A new one changes this list and needs review in the PR. Public routes are listed
 * for the same reason.
 */
describe('route markers', () => {
  let routes: Route[];

  beforeAll(async () => {
    routes = await listRoutes();
  });

  it('lists every @Authenticated() route', () => {
    expect(routes.filter((r) => r.marker === 'authenticated').map((r) => r.route)).toEqual([
      'GET /api/v1/auth/me',
      'POST /api/v1/auth/switch-organization',
    ]);
  });

  it('lists every @Public() route', () => {
    expect(routes.filter((r) => r.marker === 'public').map((r) => r.route)).toEqual([
      'GET /api/v1/health',
      'GET /api/v1/health/live',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/verify-email',
      'POST /api/v1/auth/verify-email/resend',
    ]);
  });
});
