import { locationListResponseSchema, locationSchema } from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthApp, type AuthTestKit } from './support/auth-app';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/platform/web-shell.md → Locations (ADR 0015 §11). */
describe('/locations', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
  });

  afterAll(async () => {
    await kit.close();
  });

  async function tokenAs(org: SeededOrg, roleId: string, locations?: string[]) {
    const user = await kit.createUser();
    await seed.member(org.id, user.id, roleId, locations ? { locations } : {});
    return seed.token(user.id, org.id);
  }

  const list = (token: string) =>
    request(kit.server).get('/api/v1/locations').auth(token, { type: 'bearer' });

  const send = (
    token: string,
    method: 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    key = uuidv7(),
  ) =>
    withIdempotencyKey(
      request(kit.server)[method](`/api/v1/locations${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body ?? {});

  const names = async (token: string) =>
    locationListResponseSchema.parse((await list(token).expect(200)).body).data.map((l) => l.name);

  describe('GET', () => {
    it('lists every location of the organization for an all-locations member (Staff too)', async () => {
      const res = await list(await tokenAs(a, a.roles.staff)).expect(200);
      const body = locationListResponseSchema.parse(res.body);
      expect(body.data.map((l) => l.id).sort()).toEqual([...a.locations].sort());
      expect(body.data.map((l) => l.name)).toEqual(['L1', 'L2']);
    });

    it('shows a location-limited member only their locations', async () => {
      const token = await tokenAs(a, a.roles.staff, [a.locations[1]]);
      const res = await list(token).expect(200);
      expect(locationListResponseSchema.parse(res.body).data.map((l) => l.id)).toEqual([
        a.locations[1],
      ]);
    });

    it('needs platform.settings.read', async () => {
      const role = await seed.customRole(a.id, ['platform.users.read']);
      const res = await list(await tokenAs(a, role)).expect(403);
      expect(res.body).toMatchObject({
        code: 'rbac.permission_denied',
        details: { permission: 'platform.settings.read' },
      });
    });

    it("never shows another organization's locations", async () => {
      const res = await list(await tokenAs(b, b.roles.owner)).expect(200);
      const ids = locationListResponseSchema.parse(res.body).data.map((l) => l.id);
      expect(ids.sort()).toEqual([...b.locations].sort());
      expect(ids).not.toContain(a.locations[0]);
    });
  });

  describe('create, rename, delete (owner only)', () => {
    it('creates in the existing brand, renames and deletes an unused location', async () => {
      const org = await seed.org('C');
      const owner = await tokenAs(org, org.roles.owner);
      const created = locationSchema.parse(
        (await send(owner, 'post', '', { name: ' Second street ' }).expect(201)).body,
      );
      expect(created.name).toBe('Second street');
      const brands = await seed.as(org.id, (db) => db.brand.findMany({ select: { id: true } }));
      expect(brands.map((x) => x.id)).toEqual([created.brandId]);

      const renamed = locationSchema.parse(
        (await send(owner, 'patch', `/${created.id}`, { name: 'Harbour' }).expect(200)).body,
      );
      expect(renamed).toEqual({ ...created, name: 'Harbour' });
      expect(await names(owner)).toEqual(['Harbour', 'L1', 'L2']);

      await send(owner, 'delete', `/${created.id}`).expect(204);
      expect(await names(owner)).toEqual(['L1', 'L2']);
      const gone = await send(owner, 'delete', `/${created.id}`).expect(404);
      expect(gone.body).toMatchObject({ code: 'rbac.location_not_found' });
    });

    it("creates the organization's brand with its first location", async () => {
      const org = await seed.org('Fresh bistro');
      await seed.as(org.id, async (db) => {
        await db.location.deleteMany({});
        await db.brand.deleteMany({});
      });
      const owner = await tokenAs(org, org.roles.owner);
      const created = locationSchema.parse(
        (await send(owner, 'post', '', { name: 'Main street' }).expect(201)).body,
      );
      const brands = await seed.as(org.id, (db) =>
        db.brand.findMany({ select: { id: true, name: true } }),
      );
      expect(brands).toEqual([{ id: created.brandId, name: 'Fresh bistro' }]);
    });

    it('keeps names unique per organization (ignoring case) and validates', async () => {
      const org = await seed.org();
      const owner = await tokenAs(org, org.roles.owner);
      const taken = await send(owner, 'post', '', { name: 'l1' }).expect(409);
      expect(taken.body).toMatchObject({ code: 'locations.name_taken' });
      await send(owner, 'patch', `/${org.locations[1]}`, { name: 'L1' }).expect(409);
      // Its own name in another case is fine.
      await send(owner, 'patch', `/${org.locations[0]}`, { name: 'l1' }).expect(200);
      await send(owner, 'post', '', { name: '  ' }).expect(400);
      await send(owner, 'post', '', { name: 'x'.repeat(101) }).expect(400);
      await send(owner, 'post', '', { name: 'X', brandId: uuidv7() }).expect(400);
      const bad = await send(owner, 'patch', '/not-a-uuid', { name: 'X' }).expect(404);
      expect(bad.body).toMatchObject({ code: 'rbac.location_not_found' });
      // Another organization may use the same name.
      const other = await seed.org();
      await send(await tokenAs(other, other.roles.owner), 'post', '', { name: 'Harbour' }).expect(
        201,
      );
      await send(owner, 'post', '', { name: 'Harbour' }).expect(201);
    });

    it('refuses to delete a location still in use', async () => {
      const org = await seed.org();
      const owner = await tokenAs(org, org.roles.owner);
      // L1: a member limited to it.
      await tokenAs(org, org.roles.staff, [org.locations[0]]);
      const res = await send(owner, 'delete', `/${org.locations[0]}`).expect(409);
      expect(res.body).toMatchObject({ code: 'locations.in_use' });
      // L2: a table (module data the platform never looks at itself).
      await seed.as(org.id, (db) =>
        db.diningTable.create({
          data: { tenantId: org.id, locationId: org.locations[1], name: 'T1', seats: 2 },
        }),
      );
      await send(owner, 'delete', `/${org.locations[1]}`).expect(409);
      expect(await names(owner)).toEqual(['L1', 'L2']);
    });

    it.each(['admin', 'manager', 'staff', 'waiter', 'cashier'] as const)(
      'refuses %s (platform.org.manage is owner only)',
      async (role) => {
        const org = await seed.org();
        const token = await tokenAs(org, org.roles[role]);
        const res = await send(token, 'post', '', { name: 'New' }).expect(403);
        expect(res.body).toMatchObject({
          code: 'rbac.permission_denied',
          details: { permission: 'platform.org.manage' },
        });
        await send(token, 'patch', `/${org.locations[0]}`, { name: 'New' }).expect(403);
        await send(token, 'delete', `/${org.locations[1]}`).expect(403);
      },
    );

    it('replays a repeated create instead of creating twice', async () => {
      const org = await seed.org();
      const owner = await tokenAs(org, org.roles.owner);
      const key = uuidv7();
      const first = await send(owner, 'post', '', { name: 'Once' }, key).expect(201);
      const again = await send(owner, 'post', '', { name: 'Once' }, key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await names(owner)).toEqual(['L1', 'L2', 'Once']);
    });

    it('records create, rename and delete in the audit log, and nothing for no-ops', async () => {
      const org = await seed.org();
      const owner = await tokenAs(org, org.roles.owner);
      const created = locationSchema.parse(
        (await send(owner, 'post', '', { name: 'A' }).expect(201)).body,
      );
      await send(owner, 'patch', `/${created.id}`, { name: 'B' }).expect(200);
      await send(owner, 'patch', `/${created.id}`, { name: 'B' }).expect(200);
      await send(owner, 'delete', `/${created.id}`).expect(204);
      const rows = await seed.as(org.id, (db) =>
        db.auditLog.findMany({
          where: { entityType: 'location', entityId: created.id },
          orderBy: { id: 'asc' },
          select: { action: true, before: true, after: true },
        }),
      );
      expect(rows).toEqual([
        { action: 'platform.location.created', before: null, after: { ...created } },
        {
          action: 'platform.location.updated',
          before: { ...created },
          after: { ...created, name: 'B' },
        },
        { action: 'platform.location.deleted', before: { ...created, name: 'B' }, after: null },
      ]);
    });

    it("never changes another organization's locations", async () => {
      const tokenB = await tokenAs(b, b.roles.owner);
      const patch = await send(tokenB, 'patch', `/${a.locations[0]}`, { name: 'Mine' }).expect(404);
      expect(patch.body).toMatchObject({ code: 'rbac.location_not_found' });
      await send(tokenB, 'delete', `/${a.locations[1]}`).expect(404);
      expect(await names(await tokenAs(a, a.roles.owner))).toEqual(['L1', 'L2']);
    });
  });
});
