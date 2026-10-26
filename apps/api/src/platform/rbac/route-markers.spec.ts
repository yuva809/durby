import { Controller, Get, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PERMISSIONS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { Authenticated, Public } from '../auth';
import { RequireFeature } from '../config/entitlements';
import { PERMISSION_REGISTRY } from './permission-registry';
import { PlatformOnly } from '../markers';
import { RequirePermission } from '../markers';
import { RouteMarkerCheck } from './route-marker.check';

@Controller('ok')
class MarkedController {
  @Public() @Get('a') a(): void {}
  @Authenticated() @Get('b') b(): void {}
  @RequirePermission('platform.users.read') @Get('c') c(): void {}
  @PlatformOnly() @Get('d') d(): void {}
}

@RequirePermission('platform.roles.read')
@Controller('class-level')
class ClassMarkedController {
  @Get() list(): void {}
}

@Controller('unmarked')
class UnmarkedController {
  @Get() list(): void {}
}

@Controller('twice')
class TwiceController {
  @Public() @Authenticated() @Get() list(): void {}
}

@Public()
@Controller('conflict')
class ClassAndMethodController {
  @RequirePermission('platform.users.read') @Get() list(): void {}
}

@Controller('unknown')
class UnknownKeyController {
  @RequirePermission('platform.nothing.here' as never) @Get() list(): void {}
}

@RequireFeature('inventory')
@Controller('featured')
class FeatureController {
  @RequirePermission('platform.users.read') @Get('a') a(): void {}
  @RequirePermission('platform.users.read')
  @RequireFeature('inventory.counts')
  @Get('b')
  b(): void {}
}

@Controller('unknown-feature')
class UnknownFeatureController {
  @RequirePermission('platform.users.read')
  @RequireFeature('inventory.everything' as never)
  @Get()
  list(): void {}
}

@Controller('public-feature')
class PublicFeatureController {
  @Public() @RequireFeature('inventory') @Get() list(): void {}
}

@Controller('authenticated-feature')
class AuthenticatedFeatureController {
  @Authenticated() @RequireFeature('inventory') @Get() list(): void {}
}

@Controller('platform-feature')
class PlatformOnlyFeatureController {
  @PlatformOnly() @RequireFeature('inventory') @Get() list(): void {}
}

async function boot(controllers: Type[]): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers,
    providers: [RouteMarkerCheck, { provide: PERMISSION_REGISTRY, useValue: PERMISSIONS }],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    await app.init();
  } finally {
    await app.close();
  }
}

describe('route marker startup check', () => {
  it('boots when every route has exactly one marker, on the handler or the class', async () => {
    await expect(boot([MarkedController, ClassMarkedController])).resolves.toBeUndefined();
  });

  it('boots with registered @RequireFeature keys next to @RequirePermission', async () => {
    await expect(boot([MarkedController, FeatureController])).resolves.toBeUndefined();
  });

  it.each([
    [UnmarkedController, 'GET /api/v1/unmarked: no access marker'],
    [TwiceController, 'GET /api/v1/twice: 2 access markers (public, authenticated)'],
    [
      ClassAndMethodController,
      'GET /api/v1/conflict: 2 access markers (permission platform.users.read, public)',
    ],
    [
      UnknownKeyController,
      'GET /api/v1/unknown: unregistered permission key platform.nothing.here',
    ],
    [
      UnknownFeatureController,
      'GET /api/v1/unknown-feature: unregistered feature key inventory.everything',
    ],
    [
      PublicFeatureController,
      'GET /api/v1/public-feature: @RequireFeature needs @RequirePermission (ADR 0009)',
    ],
    [
      AuthenticatedFeatureController,
      'GET /api/v1/authenticated-feature: @RequireFeature needs @RequirePermission (ADR 0009)',
    ],
    [
      PlatformOnlyFeatureController,
      'GET /api/v1/platform-feature: @RequireFeature needs @RequirePermission (ADR 0009)',
    ],
  ])('refuses to boot: %o', async (controller, problem) => {
    await expect(boot([MarkedController, controller])).rejects.toThrow(problem);
  });
});
