import { Controller, Get, type INestApplication, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PERMISSIONS, type PermissionKey } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  AccessService,
  PERMISSION_REGISTRY,
  PlatformOnly,
  RequirePermission,
} from '../src/platform/rbac';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** No location-scope key exists yet; this one is registered for this test only. */
const STOCK = 'test.stock.adjust' as PermissionKey;

@Controller('rbac-probe')
class RbacProbeController {
  constructor(private readonly access: AccessService) {}

  @RequirePermission('platform.users.read')
  @Get('users')
  users(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('platform.org.manage')
  @Get('org')
  org(): { ok: true } {
    return { ok: true };
  }

  @PlatformOnly('staff.portal.access')
  @Get('platform')
  platform(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission(STOCK)
  @Get('stock')
  async stock(): Promise<{ locations: 'all' | string[] }> {
    return { locations: await this.access.locationIdsFor(STOCK) };
  }

  @RequirePermission(STOCK)
  @Get('stock/:locationId')
  async stockAt(@Param('locationId') locationId: string): Promise<{ ok: true }> {
    await this.access.assert(STOCK, { locationId });
    return { ok: true };
  }
}

describe('AccessGuard and @RequirePermission', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RbacProbeController],
    })
      .overrideProvider(PERMISSION_REGISTRY)
      .useValue({ ...PERMISSIONS, [STOCK]: { scope: 'location', label: 'test.stock.adjust' } })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, token: string) =>
    request(server).get(`/api/v1/rbac-probe/${path}`).auth(token, { type: 'bearer' });

  async function memberOf(org: SeededOrg, roleId: string, opts?: { locations?: string[] }) {
    const userId = await seed.user();
    await seed.member(org.id, userId, roleId, opts);
    return { userId, token: await seed.token(userId, org.id) };
  }

  it('allows and denies by the system role permissions', async () => {
    const owner = await memberOf(a, a.roles.owner);
    const admin = await memberOf(a, a.roles.admin);
    const staff = await memberOf(a, a.roles.staff);

    await get('users', owner.token).expect(200);
    await get('org', owner.token).expect(200);
    await get('users', admin.token).expect(200);
    const denied = await get('org', admin.token).expect(403);
    expect(denied.body).toEqual({
      code: 'rbac.permission_denied',
      message: expect.any(String) as unknown,
      details: { permission: 'platform.org.manage' },
    });
    await get('users', staff.token).expect(403);
  });

  it('needs a token (401) and an active organization (403 tenancy.context_missing)', async () => {
    await request(server).get('/api/v1/rbac-probe/users').expect(401);
    const owner = await memberOf(a, a.roles.owner);
    const res = await get('users', await seed.token(owner.userId, null)).expect(403);
    expect(res.body).toMatchObject({ code: 'tenancy.context_missing' });
  });

  it('never lets a customer token through a @PlatformOnly route, not even an owner', async () => {
    await request(server).get('/api/v1/rbac-probe/platform').expect(401);
    const owner = await memberOf(a, a.roles.owner);
    const res = await get('platform', owner.token).expect(401);
    expect(res.body).toMatchObject({ code: 'staff.unauthenticated' });
  });

  it('grants nothing without a membership or with a role that has no permissions', async () => {
    const stranger = await seed.user();
    await get('users', await seed.token(stranger, a.id)).expect(403);
    // Every membership has a role since step 1.11 (role_id NOT NULL); an empty custom role is the
    // closest thing to "no role".
    const empty = await memberOf(a, await seed.customRole(a.id, []));
    await get('users', empty.token).expect(403);
  });

  it('resolves permissions per request: a role change applies to the same token at once', async () => {
    const user = await memberOf(a, a.roles.staff);
    await get('users', user.token).expect(403);
    await seed.as(a.id, (db) =>
      db.membership.updateMany({ where: { userId: user.userId }, data: { roleId: a.roles.admin } }),
    );
    await get('users', user.token).expect(200);
  });

  it('applies custom role permissions and ignores keys that are not registered', async () => {
    const role = await seed.customRole(a.id, ['platform.users.read', 'gone.key.removed']);
    const user = await memberOf(a, role);
    await get('users', user.token).expect(200);
    await get('org', user.token).expect(403);
  });

  describe('location scope', () => {
    it('limits location-scope keys to the membership locations', async () => {
      const role = await seed.customRole(a.id, [STOCK, 'platform.users.read']);
      const [l1, l2] = a.locations;
      const user = await memberOf(a, role, { locations: [l1] });

      await get(`stock/${l1}`, user.token).expect(200);
      const res = await get(`stock/${l2}`, user.token).expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });
      expect((await get('stock', user.token).expect(200)).body).toEqual({ locations: [l1] });
      // Organization-scope keys need a membership covering all locations.
      await get('users', user.token).expect(403);
    });

    it('covers every location without a location limit', async () => {
      const role = await seed.customRole(a.id, [STOCK]);
      const user = await memberOf(a, role);
      await get(`stock/${a.locations[1]}`, user.token).expect(200);
      expect((await get('stock', user.token).expect(200)).body).toEqual({ locations: 'all' });
    });

    it('a location-limited membership without locations covers none (fails closed)', async () => {
      const role = await seed.customRole(a.id, [STOCK]);
      const user = await memberOf(a, role, { locations: [] });
      await get('stock', user.token).expect(403);
      await get(`stock/${a.locations[0]}`, user.token).expect(403);
    });

    it("a location-limited member is denied another organization's location id", async () => {
      const role = await seed.customRole(a.id, [STOCK]);
      const user = await memberOf(a, role, { locations: [a.locations[0]] });
      await get(`stock/${b.locations[0]}`, user.token).expect(403);
    });
  });

  describe('cross-tenant', () => {
    it('an owner of A has no permissions with a token for B', async () => {
      const owner = await memberOf(a, a.roles.owner);
      await get('users', await seed.token(owner.userId, b.id)).expect(403);
    });

    it("a membership can never point at another organization's role (composite FK)", async () => {
      const userId = await seed.user();
      await expect(seed.member(a.id, userId, b.roles.owner)).rejects.toThrow(
        /memberships_tenant_id_role_id_fkey|Foreign key/i,
      );
    });

    it("a membership can never be limited to another organization's location (composite FK)", async () => {
      const userId = await seed.user();
      await expect(
        seed.member(a.id, userId, a.roles.staff, { locations: [b.locations[0]] }),
      ).rejects.toThrow(/membership_locations_tenant_id_location_id_fkey|Foreign key/i);
    });

    it("RLS hides another organization's roles", async () => {
      const visible = await seed.as(a.id, (db) => db.role.findMany({ select: { id: true } }));
      expect(visible.map((r) => r.id)).not.toContain(b.roles.owner);
      expect(visible.map((r) => r.id)).toContain(a.roles.owner);
    });
  });
});
