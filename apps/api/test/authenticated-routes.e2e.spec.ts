import { Controller, Get } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { listRoutes, type RouteInfo } from '../src/platform/rbac';

async function routesOf(): Promise<RouteInfo[]> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  try {
    return listRoutes(
      moduleRef.get(DiscoveryService),
      moduleRef.get(MetadataScanner),
      moduleRef.get(Reflector),
    );
  } finally {
    await moduleRef.close();
  }
}

const withMarker = (routes: RouteInfo[], kind: string): string[] =>
  routes.filter((r) => r.markers.some((m) => m.kind === kind)).map((r) => r.route);

/**
 * CLAUDE.md rule 10 / ADR 0006: @Authenticated() is only for user-level routes that never touch
 * tenant data. A new one changes this list and needs review in the PR. Public routes are listed
 * for the same reason.
 */
describe('route markers', () => {
  let routes: RouteInfo[];

  beforeAll(async () => {
    routes = await routesOf();
  });

  it('lists every @Authenticated() route', () => {
    expect(withMarker(routes, 'authenticated')).toEqual([
      'GET /api/v1/auth/me',
      // ADR 0009 §6: reads only the token's active organization's features, for a member.
      'GET /api/v1/me/entitlements',
      'POST /api/v1/auth/switch-organization',
      // ADR 0007: writes only the caller's own membership, in the tenant the invitation proves.
      'POST /api/v1/invitations/accept-signed-in',
    ]);
  });

  it('lists every @Public() route', () => {
    expect(withMarker(routes, 'public')).toEqual([
      'GET /api/v1/health',
      'GET /api/v1/health/live',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/verify-email',
      'POST /api/v1/auth/verify-email/resend',
      // ADR 0007: authenticated by the single-use invitation token.
      'POST /api/v1/invitations/accept',
      'POST /api/v1/invitations/preview',
    ]);
  });

  it('gives every route exactly one marker (the startup check passes)', () => {
    expect(routes.filter((r) => r.markers.length !== 1)).toEqual([]);
  });

  it('refuses to boot the api when a route has no marker', async () => {
    @Controller('forgotten')
    class ForgottenController {
      @Get()
      list(): void {}
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ForgottenController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await expect(app.init()).rejects.toThrow('GET /api/v1/forgotten: no access marker');
    await app.close();
  });
});
