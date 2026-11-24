import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  areaFloorPlanResponseSchema,
  diningAreaSchema,
  diningTableListResponseSchema,
  diningTableSchema,
  type FloorPlanLayout,
  floorPlanVersionSchema,
  livePlansResponseSchema,
  publishFloorPlanResponseSchema,
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

/** docs/modules/pos.md → Step 8 (ADR 0073): versions, restore, publish, access, isolation. */
describe('floor plans', () => {
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

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: object = {}, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body);
  const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], {
      displayName: `The ${role}`,
      ...(locations ? { locations } : {}),
    });
    return seed.token(userId, org.id);
  }

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await member(org, 'owner');
    const [here, there] = org.locations;
    const area = async (locationId: string, name: string) =>
      diningAreaSchema.parse(
        (await post(owner, '/pos/areas', { locationId, name }).expect(201)).body,
      ).id;
    const table = async (name: string, areaId: string | null, locationId = here) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4, areaId }).expect(201)).body,
      ).id;
    const room = await area(here, 'Room');
    return {
      org,
      owner,
      here,
      there,
      area,
      table,
      room,
      t1: await table('T1', room),
      t2: await table('T2', room),
    };
  }

  const at = (n: number, extra: object) => ({
    key: `t-${n}`,
    x: n * 100,
    y: 100,
    width: 80,
    height: 80,
    tableId: null,
    create: null,
    ...extra,
  });
  const fresh = (name: string) => ({
    create: { name, seats: 6, shape: 'round' as const },
  });
  const layout = (...tables: object[]): FloorPlanLayout =>
    ({
      room: { width: 1000, height: 600 },
      tables,
      pieces: [{ key: 'bar', kind: 'bar', x: 0, y: 500, width: 300, height: 60 }],
    }) as FloorPlanLayout;

  const path = (areaId: string) => `/pos/areas/${areaId}/floor-plan`;
  const save = (token: string, areaId: string, baseVersion: number, plan: FloorPlanLayout) =>
    post(token, `${path(areaId)}/versions`, { baseVersion, layout: plan });
  const saved = async (token: string, areaId: string, base: number, plan: FloorPlanLayout) =>
    floorPlanVersionSchema.parse((await save(token, areaId, base, plan).expect(201)).body);
  const plan = async (token: string, areaId: string) =>
    areaFloorPlanResponseSchema.parse((await get(token, path(areaId)).expect(200)).body);
  const publish = (token: string, areaId: string, version: number, key?: string) =>
    post(token, `${path(areaId)}/publish`, { version }, key);
  const live = async (token: string, locationId: string) =>
    livePlansResponseSchema.parse(
      (await get(token, `/pos/floor/plans?locationId=${locationId}`).expect(200)).body,
    ).data;
  const tables = async (token: string, locationId: string) =>
    diningTableListResponseSchema.parse(
      (await get(token, `/pos/tables?locationId=${locationId}`).expect(200)).body,
    ).data;
  const audits = (org: SeededOrg) =>
    seed.as(org.id, (db) =>
      db.auditLog.findMany({
        where: { action: { startsWith: 'pos.floor_plan' } },
        select: { action: true, after: true },
        orderBy: { id: 'asc' },
      }),
    );

  it('saves versions and lists them, newest first', async () => {
    const s = await setup();
    expect(await plan(s.owner, s.room)).toEqual({
      area: { id: s.room, locationId: s.here, name: 'Room' },
      latest: null,
      live: null,
      history: [],
    });
    const one = layout(at(1, { tableId: s.t1 }));
    const two = layout(at(1, { tableId: s.t1 }), at(2, { tableId: s.t2 }), at(3, fresh('T3')));
    expect(await saved(s.owner, s.room, 0, one)).toEqual({ version: 1, layout: one });
    expect((await saved(s.owner, s.room, 1, two)).version).toBe(2);
    const res = await plan(s.owner, s.room);
    expect(res.latest).toEqual({ version: 2, layout: two });
    expect(res.live).toBeNull();
    expect(res.history).toMatchObject([
      { version: 2, restoredFrom: null, tables: 3, pieces: 1, createdBy: 'The owner' },
      { version: 1, restoredFrom: null, tables: 1, pieces: 1 },
    ]);
    const first = await get(s.owner, `${path(s.room)}/versions/1`).expect(200);
    expect(floorPlanVersionSchema.parse(first.body).layout).toEqual(one);
    // Nothing is live and no table was made.
    expect(await live(s.owner, s.here)).toEqual([]);
    expect((await tables(s.owner, s.here)).map((t) => t.name)).toEqual(['T1', 'T2']);
    expect(await audits(s.org)).toMatchObject([
      {
        action: 'pos.floor_plan.saved',
        after: { areaId: s.room, locationId: s.here, version: 1, tableCount: 1, pieceCount: 1 },
      },
      { action: 'pos.floor_plan.saved', after: { version: 2, tableCount: 3 } },
    ]);
  });

  it('refuses a save over someone else’s, also when both come at once', async () => {
    const s = await setup();
    await saved(s.owner, s.room, 0, layout());
    const stale = await save(s.owner, s.room, 0, layout()).expect(409);
    expect(codeOf(stale)).toBe('pos.floor_plan_changed');
    expect(codeOf(await save(s.owner, s.room, 2, layout()).expect(409))).toBe(
      'pos.floor_plan_changed',
    );
    const both = await Promise.all([1, 2].map(() => save(s.owner, s.room, 1, layout())));
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await plan(s.owner, s.room)).history).toHaveLength(2);
  });

  it('replays a repeated save instead of saving twice', async () => {
    const s = await setup();
    const key = uuidv7();
    const body = { baseVersion: 0, layout: layout() };
    const first = await post(s.owner, `${path(s.room)}/versions`, body, key).expect(201);
    const again = await post(s.owner, `${path(s.room)}/versions`, body, key).expect(201);
    expect(again.body).toEqual(first.body);
    expect((await plan(s.owner, s.room)).history).toHaveLength(1);
  });

  it('refuses bad layouts and tables that are not in the area or out of service', async () => {
    const s = await setup();
    const terrace = await s.area(s.here, 'Terrace');
    const outside = await s.table('T9', terrace);
    const loose = await s.table('T8', null);
    const gone = await s.table('T7', s.room);
    await withIdempotencyKey(
      request(server).patch(`/api/v1/pos/tables/${gone}`).auth(s.owner, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ archived: true })
      .expect(200);
    const other = await setup();
    for (const tableId of [outside, loose, gone, other.t1, uuidv7()]) {
      const res = await save(s.owner, s.room, 0, layout(at(1, { tableId }))).expect(409);
      expect(codeOf(res)).toBe('pos.floor_plan_table_invalid');
    }
    for (const bad of [
      layout(at(1, {})),
      layout(at(1, { tableId: s.t1, x: 950 })),
      layout(at(1, { tableId: s.t1 }), at(2, { tableId: s.t1 })),
      layout(at(1, { tableId: s.t1, rotation: 90 })),
    ]) {
      await save(s.owner, s.room, 0, bad).expect(400);
    }
    await post(s.owner, `${path(s.room)}/versions`, { layout: layout() }).expect(400);
    expect((await plan(s.owner, s.room)).history).toEqual([]);
  });

  it('restores an old version as a new one', async () => {
    const s = await setup();
    const one = layout(at(1, { tableId: s.t1 }));
    await saved(s.owner, s.room, 0, one);
    await saved(s.owner, s.room, 1, layout());
    const restore = (version: number | string, baseVersion: number) =>
      post(s.owner, `${path(s.room)}/versions/${version}/restore`, { baseVersion });
    expect(codeOf(await restore(1, 1).expect(409))).toBe('pos.floor_plan_changed');
    expect(codeOf(await restore(9, 2).expect(404))).toBe('pos.floor_plan_not_found');
    expect(codeOf(await restore('x', 2).expect(404))).toBe('pos.floor_plan_not_found');
    const res = await restore(1, 2).expect(201);
    expect(floorPlanVersionSchema.parse(res.body)).toEqual({ version: 3, layout: one });
    expect((await plan(s.owner, s.room)).history[0]).toMatchObject({
      version: 3,
      restoredFrom: 1,
    });
    expect((await audits(s.org)).at(-1)).toMatchObject({
      action: 'pos.floor_plan.restored',
      after: { version: 3, restoredFrom: 1 },
    });
  });

  it('publishes a version; the newest publication is live', async () => {
    const s = await setup();
    const one = layout(at(1, { tableId: s.t1 }));
    const two = layout(at(2, { tableId: s.t1 }), at(3, { tableId: s.t2 }));
    await saved(s.owner, s.room, 0, one);
    await saved(s.owner, s.room, 1, two);
    const res = publishFloorPlanResponseSchema.parse(
      (await publish(s.owner, s.room, 2).expect(201)).body,
    );
    expect(res).toEqual({ version: 2, layout: two, created: [] });
    expect(await live(s.owner, s.here)).toEqual([
      { areaId: s.room, areaName: 'Room', version: 2, layout: two },
    ]);
    // Back to the first one; its positions are live again.
    await publish(s.owner, s.room, 1).expect(201);
    expect((await live(s.owner, s.here))[0]).toMatchObject({ version: 1, layout: one });
    // Live already: nothing more is written.
    await publish(s.owner, s.room, 1).expect(201);
    expect(await seed.as(s.org.id, (db) => db.posFloorPlanPublication.count({}))).toBe(2);
    expect((await plan(s.owner, s.room)).live?.version).toBe(1);
    expect(codeOf(await publish(s.owner, s.room, 9).expect(404))).toBe('pos.floor_plan_not_found');
    expect((await audits(s.org)).filter((a) => a.action.endsWith('published'))).toHaveLength(2);
    // Publishing never touches the tables.
    const before = await tables(s.owner, s.here);
    expect(before.map((t) => [t.name, t.floorX])).toEqual([
      ['T1', 100],
      ['T2', 260],
    ]);
  });

  it('creates the new tables when publishing, once', async () => {
    const s = await setup();
    await saved(
      s.owner,
      s.room,
      0,
      layout(at(1, { tableId: s.t1 }), at(2, fresh('T3')), at(3, fresh('T4'))),
    );
    const key = uuidv7();
    const res = publishFloorPlanResponseSchema.parse(
      (await publish(s.owner, s.room, 1, key).expect(201)).body,
    );
    expect(res.version).toBe(2);
    expect(res.created.map((t) => t.name)).toEqual(['T3', 'T4']);
    const ids = new Map(res.created.map((t) => [t.name, t.id]));
    expect(res.layout.tables.map((t) => [t.tableId, t.create])).toEqual([
      [s.t1, null],
      [ids.get('T3'), null],
      [ids.get('T4'), null],
    ]);
    const now = await tables(s.owner, s.here);
    expect(now.find((t) => t.name === 'T3')).toMatchObject({
      id: ids.get('T3'),
      areaId: s.room,
      area: 'Room',
      seats: 6,
      shape: 'round',
      archivedAt: null,
    });
    expect((await plan(s.owner, s.room)).live?.version).toBe(2);
    // A retry of the same click answers the same and creates nothing.
    expect((await publish(s.owner, s.room, 1, key).expect(201)).body).toEqual(res);
    expect(await tables(s.owner, s.here)).toHaveLength(4);
    // Publishing the old draft again would create them again: the names are taken.
    expect(codeOf(await publish(s.owner, s.room, 1).expect(409))).toBe('pos.table_name_taken');
  });

  it('creates nothing when one name is taken', async () => {
    const s = await setup();
    await s.table('T4', null);
    await saved(s.owner, s.room, 0, layout(at(1, fresh('T3')), at(2, fresh('T4'))));
    expect(codeOf(await publish(s.owner, s.room, 1).expect(409))).toBe('pos.table_name_taken');
    expect((await tables(s.owner, s.here)).map((t) => t.name).sort()).toEqual(['T1', 'T2', 'T4']);
    const res = await plan(s.owner, s.room);
    expect(res.live).toBeNull();
    expect(res.history).toHaveLength(1);
  });

  it('keeps the plan when a table leaves the area, and its history when the area goes', async () => {
    const s = await setup();
    const terrace = await s.area(s.here, 'Terrace');
    const t5 = await s.table('T5', terrace);
    const both = layout(at(1, { tableId: t5 }));
    await saved(s.owner, terrace, 0, both);
    await publish(s.owner, terrace, 1).expect(201);
    await withIdempotencyKey(
      request(server).patch(`/api/v1/pos/tables/${t5}`).auth(s.owner, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ areaId: s.room })
      .expect(200);
    // Still named by the plan (screens leave it out); restoring and publishing it stay possible.
    expect((await live(s.owner, s.here))[0]!.layout).toEqual(both);
    await post(s.owner, `${path(terrace)}/versions/1/restore`, { baseVersion: 1 }).expect(201);
    await publish(s.owner, terrace, 2).expect(201);
    await withIdempotencyKey(
      request(server).delete(`/api/v1/pos/areas/${terrace}`).auth(s.owner, { type: 'bearer' }),
      uuidv7(),
    ).expect(204);
    expect(await live(s.owner, s.here)).toEqual([]);
    expect(codeOf(await get(s.owner, path(terrace)).expect(404))).toBe('pos.area_not_found');
    expect(codeOf(await save(s.owner, terrace, 2, layout()).expect(404))).toBe(
      'pos.area_not_found',
    );
    expect(
      await seed.as(s.org.id, (db) => db.posFloorPlanVersion.count({ where: { areaId: terrace } })),
    ).toBe(2);
  });

  it('checks each role at the area’s location', async () => {
    const s = await setup();
    await saved(s.owner, s.room, 0, layout(at(1, fresh('T3'))));
    for (const role of ['admin', 'manager'] as const) {
      const token = await member(s.org, role);
      const base = (await plan(token, s.room)).history.length;
      await save(token, s.room, base, layout(at(1, { tableId: s.t1 }))).expect(201);
      await publish(token, s.room, base + 1).expect(201);
    }
    const waiter = await member(s.org, 'waiter');
    expect((await live(waiter, s.here))[0]!.areaName).toBe('Room');
    await get(waiter, path(s.room)).expect(200);
    for (const role of ['waiter', 'cashier'] as const) {
      const token = await member(s.org, role);
      await save(token, s.room, 3, layout()).expect(403);
      await publish(token, s.room, 1).expect(403);
      await post(token, `${path(s.room)}/versions/1/restore`, { baseVersion: 3 }).expect(403);
    }
    for (const role of ['kitchen', 'bar'] as const) {
      const token = await member(s.org, role);
      await get(token, path(s.room)).expect(403);
    }
    // A manager of the other location: this area doesn't exist for them.
    const elsewhere = await member(s.org, 'manager', [s.there]);
    expect(codeOf(await get(elsewhere, path(s.room)).expect(404))).toBe('pos.area_not_found');
    expect(codeOf(await save(elsewhere, s.room, 3, layout()).expect(404))).toBe(
      'pos.area_not_found',
    );
    expect(codeOf(await publish(elsewhere, s.room, 1).expect(404))).toBe('pos.area_not_found');
    expect(codeOf(await get(elsewhere, `/pos/floor/plans?locationId=${s.here}`).expect(404))).toBe(
      'pos.location_not_found',
    );
    expect((await plan(s.owner, s.room)).history).toHaveLength(3);
  });

  it('needs the right to add tables for a plan with new ones', async () => {
    const s = await setup();
    const roleId = await seed.customRole(s.org.id, [
      'pos.tables.read',
      'pos.tables.edit',
      'pos.orders.read',
    ]);
    const userId = await seed.user();
    await seed.member(s.org.id, userId, roleId);
    const editor = await seed.token(userId, s.org.id);
    await saved(editor, s.room, 0, layout(at(1, fresh('T3'))));
    await publish(editor, s.room, 1).expect(403);
    expect(await tables(s.owner, s.here)).toHaveLength(2);
    await saved(editor, s.room, 1, layout(at(1, { tableId: s.t1 })));
    await publish(editor, s.room, 2).expect(201);
  });

  it('keeps organizations apart', async () => {
    const s = await setup();
    const other = await setup();
    await saved(s.owner, s.room, 0, layout(at(1, { tableId: s.t1 })));
    await publish(s.owner, s.room, 1).expect(201);
    await get(other.owner, path(s.room)).expect(404);
    await get(other.owner, `${path(s.room)}/versions/1`).expect(404);
    await save(other.owner, s.room, 1, layout()).expect(404);
    await publish(other.owner, s.room, 1).expect(404);
    await get(other.owner, `/pos/floor/plans?locationId=${s.here}`).expect(404);
    const [versions, publications] = await seed.as(other.org.id, async (db) => [
      await db.posFloorPlanVersion.count({}),
      await db.posFloorPlanPublication.count({}),
    ]);
    expect([versions, publications]).toEqual([0, 0]);
    await expect(
      seed.as(other.org.id, (db) =>
        db.posFloorPlanVersion.create({
          data: {
            tenantId: s.org.id,
            locationId: s.here,
            areaId: s.room,
            version: 2,
            layout: {},
            createdByUserId: uuidv7(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('needs the pos feature', async () => {
    const s = await setup();
    await entitlements.setOverride(s.org.id, 'pos', false, undefined, 'cli.entitlements');
    for (const res of [
      await get(s.owner, path(s.room)).expect(403),
      await save(s.owner, s.room, 0, layout()).expect(403),
      await publish(s.owner, s.room, 1).expect(403),
      await get(s.owner, `/pos/floor/plans?locationId=${s.here}`).expect(403),
    ]) {
      expect(codeOf(res)).toBe('entitlements.feature_disabled');
    }
  });

  it('does not change or delete what was saved', async () => {
    const s = await setup();
    await saved(s.owner, s.room, 0, layout());
    await publish(s.owner, s.room, 1).expect(201);
    await expect(
      seed.as(s.org.id, (db) => db.posFloorPlanVersion.updateMany({ data: { version: 5 } })),
    ).rejects.toThrow();
    await expect(
      seed.as(s.org.id, (db) => db.posFloorPlanPublication.deleteMany({})),
    ).rejects.toThrow();
  });
});
