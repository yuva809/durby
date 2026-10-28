import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningAreaListResponseSchema,
  diningAreaSchema,
  diningTableSchema,
  floorResponseSchema,
  type PlanKey,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/pos.md → Areas: per location, unique names, delete only when empty, access, isolation. */
describe('/api/v1/pos/areas', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgWith(
    role: SystemRole,
    plan: PlanKey = 'full',
  ): Promise<{ org: SeededOrg; token: string }> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    return { org, token: await memberToken(org, role) };
  }

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });

  const send = (
    token: string,
    method: 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    key = uuidv7(),
  ) =>
    withIdempotencyKey(
      request(server)[method](`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send((body ?? {}));

  async function area(token: string, locationId: string, name: string, sortOrder?: number) {
    const res = await send(token, 'post', '/pos/areas', { locationId, name, sortOrder }).expect(
      201,
    );
    return diningAreaSchema.parse(res.body);
  }

  async function table(token: string, locationId: string, name: string, areaId?: string) {
    const res = await send(token, 'post', '/pos/tables', {
      locationId,
      name,
      seats: 4,
      ...(areaId ? { areaId } : {}),
    }).expect(201);
    return diningTableSchema.parse(res.body);
  }

  const areas = async (token: string, query = '') =>
    diningAreaListResponseSchema.parse((await get(token, `/pos/areas${query}`).expect(200)).body)
      .data;

  it('creates, lists in sort order with table counts, renames and deletes when empty', async () => {
    const { org, token } = await orgWith('owner');
    const [l1, l2] = org.locations;
    const terrace = await area(token, l1, ' Terrace ', 2);
    const dining = await area(token, l1, 'Dining room', 1);
    await area(token, l2, 'Bar');
    expect(terrace).toMatchObject({ name: 'Terrace', tableCount: 0, locationId: l1 });

    const t1 = await table(token, l1, 'T1', terrace.id);
    const t2 = await table(token, l1, 'T2', terrace.id);
    await send(token, 'patch', `/pos/tables/${t2.id}`, { archived: true }).expect(200);

    expect((await areas(token, `?locationId=${l1}`)).map((a) => [a.name, a.tableCount])).toEqual([
      ['Dining room', 0],
      ['Terrace', 1],
    ]);
    expect((await areas(token)).map((a) => a.name)).toEqual(['Bar', 'Dining room', 'Terrace']);

    // A rename shows on its tables (and on the POS floor).
    const renamed = diningAreaSchema.parse(
      (await send(token, 'patch', `/pos/areas/${terrace.id}`, { name: 'Garden' }).expect(200)).body,
    );
    expect(renamed).toMatchObject({ name: 'Garden', tableCount: 1 });
    const floor = floorResponseSchema.parse((await get(token, '/pos/floor').expect(200)).body);
    expect(floor.data.find((t) => t.id === t1.id)?.area).toBe('Garden');

    // Not empty while a table uses it, also one out of service.
    await send(token, 'patch', `/pos/tables/${t1.id}`, { areaId: dining.id }).expect(200);
    const blocked = await send(token, 'delete', `/pos/areas/${terrace.id}`).expect(409);
    expect(blocked.body).toMatchObject({ code: 'pos.area_not_empty' });
    await send(token, 'patch', `/pos/tables/${t2.id}`, { areaId: null }).expect(200);
    await send(token, 'delete', `/pos/areas/${terrace.id}`).expect(204);
    expect((await areas(token, `?locationId=${l1}`)).map((a) => a.name)).toEqual(['Dining room']);
  });

  it('keeps names unique per location and validates', async () => {
    const { org, token } = await orgWith('owner');
    const [l1, l2] = org.locations;
    await area(token, l1, 'Terrace');
    await area(token, l2, 'Terrace');
    const taken = await send(token, 'post', '/pos/areas', {
      locationId: l1,
      name: 'Terrace',
    }).expect(409);
    expect(taken.body).toMatchObject({ code: 'pos.area_name_taken' });
    await send(token, 'post', '/pos/areas', { locationId: l1, name: '  ' }).expect(400);
    await send(token, 'post', '/pos/areas', { locationId: l1, name: 'x'.repeat(51) }).expect(400);
    const missing = await send(token, 'post', '/pos/areas', {
      locationId: uuidv7(),
      name: 'X',
    }).expect(404);
    expect(missing.body).toMatchObject({ code: 'pos.location_not_found' });
  });

  it("refuses a table in another location's area", async () => {
    const { org, token } = await orgWith('owner');
    const [l1, l2] = org.locations;
    const bar = await area(token, l2, 'Bar');
    const res = await send(token, 'post', '/pos/tables', {
      locationId: l1,
      name: 'T1',
      seats: 2,
      areaId: bar.id,
    }).expect(404);
    expect(res.body).toMatchObject({ code: 'pos.area_not_found' });
    const t = await table(token, l1, 'T1');
    await send(token, 'patch', `/pos/tables/${t.id}`, { areaId: bar.id }).expect(404);
    await send(token, 'patch', `/pos/tables/${t.id}`, { areaId: uuidv7() }).expect(404);
  });

  describe('access', () => {
    it('lets staff read, managers manage, and limits a location-limited manager', async () => {
      const { org, token: owner } = await orgWith('owner');
      const [l1, l2] = org.locations;
      const mine = await area(owner, l1, 'Mine');
      const theirs = await area(owner, l2, 'Theirs');

      const staff = await memberToken(org, 'staff');
      expect((await areas(staff)).map((a) => a.name)).toEqual(['Mine', 'Theirs']);
      await send(staff, 'post', '/pos/areas', { locationId: l1, name: 'S' }).expect(403);
      await send(staff, 'patch', `/pos/areas/${mine.id}`, { name: 'S' }).expect(403);

      const manager = await memberToken(org, 'manager', [l1]);
      expect((await areas(manager)).map((a) => a.name)).toEqual(['Mine']);
      await send(manager, 'patch', `/pos/areas/${mine.id}`, { sortOrder: 3 }).expect(200);
      await send(manager, 'post', '/pos/areas', { locationId: l2, name: 'X' }).expect(403);
      const hidden = await send(manager, 'delete', `/pos/areas/${theirs.id}`).expect(404);
      expect(hidden.body).toMatchObject({ code: 'pos.area_not_found' });
    });

    it('needs the pos feature', async () => {
      const { token } = await orgWith('owner', 'inventory');
      const res = await get(token, '/pos/areas').expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });

  it('replays a repeated create instead of creating twice', async () => {
    const { org, token } = await orgWith('owner');
    const key = uuidv7();
    const body = { locationId: org.locations[0], name: 'Once' };
    const first = await send(token, 'post', '/pos/areas', body, key).expect(201);
    const again = await send(token, 'post', '/pos/areas', body, key).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await seed.as(org.id, (db) => db.diningArea.count())).toBe(1);
  });

  it('records create, rename and delete in the audit log, and nothing for no-ops', async () => {
    const { org, token } = await orgWith('owner');
    const a = await area(token, org.locations[0], 'Terrace');
    await send(token, 'patch', `/pos/areas/${a.id}`, { name: 'Garden' }).expect(200);
    await send(token, 'patch', `/pos/areas/${a.id}`, { name: 'Garden' }).expect(200);
    await send(token, 'delete', `/pos/areas/${a.id}`).expect(204);
    const rows = await seed.as(org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'dining_area' },
        orderBy: { id: 'asc' },
        select: { action: true, before: true, after: true },
      }),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'pos.dining_area.created',
      'pos.dining_area.updated',
      'pos.dining_area.deleted',
    ]);
    expect(rows[0]?.after).toEqual({
      id: a.id,
      locationId: org.locations[0],
      name: 'Terrace',
      sortOrder: 0,
    });
    expect(rows[1]).toMatchObject({ before: { name: 'Terrace' }, after: { name: 'Garden' } });
    expect(rows[2]).toMatchObject({ before: { name: 'Garden' }, after: null });
  });

  it("never shows or changes another organization's areas", async () => {
    const { org: a, token: tokenA } = await orgWith('owner');
    const { org: b, token: tokenB } = await orgWith('owner');
    const terrace = await area(tokenA, a.locations[0], 'Terrace');
    expect(await areas(tokenB)).toEqual([]);
    expect(await areas(tokenB, `?locationId=${a.locations[0]}`)).toEqual([]);
    await send(tokenB, 'patch', `/pos/areas/${terrace.id}`, { name: 'Taken' }).expect(404);
    await send(tokenB, 'delete', `/pos/areas/${terrace.id}`).expect(404);
    // Nor put a table of B into A's area.
    const res = await send(tokenB, 'post', '/pos/tables', {
      locationId: b.locations[0],
      name: 'T1',
      seats: 2,
      areaId: terrace.id,
    }).expect(404);
    expect(res.body).toMatchObject({ code: 'pos.area_not_found' });
    expect((await areas(tokenA)).map((x) => x.name)).toEqual(['Terrace']);
  });
});
