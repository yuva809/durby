import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { diningTableListResponseSchema, diningTableSchema, type PlanKey } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/pos.md → Step 1: dining tables per location, access, audit, isolation. */
describe('/api/v1/pos/tables', () => {
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

  type Role = 'owner' | 'admin' | 'manager' | 'staff';

  async function orgWith(
    role: Role,
    plan: PlanKey = 'full',
  ): Promise<{ org: SeededOrg; token: string }> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    return { org, token: await memberToken(org, role) };
  }

  async function memberToken(org: SeededOrg, role: Role, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const list = (token: string, query = '') =>
    request(server).get(`/api/v1/pos/tables${query}`).auth(token, { type: 'bearer' });

  const create = (token: string, body: unknown, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post('/api/v1/pos/tables').auth(token, { type: 'bearer' }),
      key,
    ).send(body as object);

  const patch = (token: string, id: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1/pos/tables/${id}`).auth(token, { type: 'bearer' }),
    ).send(body as object);

  async function table(token: string, locationId: string, extra: object = {}) {
    const res = await create(token, {
      locationId,
      name: `T-${uuidv7()}`,
      seats: 4,
      ...extra,
    }).expect(201);
    return diningTableSchema.parse(res.body);
  }

  const names = async (token: string, query = '') =>
    diningTableListResponseSchema
      .parse((await list(token, query).expect(200)).body)
      .data.map((t) => t.name);

  it('creates, lists per location in sort order, edits and archives', async () => {
    const { org, token } = await orgWith('owner');
    const [l1, l2] = org.locations;
    const t2 = await table(token, l1, { name: 'T2', sortOrder: 2 });
    const t1 = await table(token, l1, { name: ' T1 ', seats: 2, area: ' Terrace ', sortOrder: 1 });
    expect(t1).toMatchObject({ name: 'T1', seats: 2, area: 'Terrace', locationId: l1 });
    await table(token, l2, { name: 'Bar 1' });

    expect(await names(token, `?locationId=${l1}`)).toEqual(['T1', 'T2']);
    expect(await names(token)).toEqual(['Bar 1', 'T1', 'T2']);

    const edited = diningTableSchema.parse(
      (await patch(token, t1.id, { seats: 6, area: '' }).expect(200)).body,
    );
    expect(edited).toMatchObject({ seats: 6, area: null });

    await patch(token, t2.id, { archived: true }).expect(200);
    expect(await names(token, `?locationId=${l1}`)).toEqual(['T1']);
    expect(await names(token, `?locationId=${l1}&includeArchived=true`)).toEqual(['T1', 'T2']);
  });

  it('keeps names unique per location among non-archived tables', async () => {
    const { org, token } = await orgWith('owner');
    const [l1, l2] = org.locations;
    const first = await table(token, l1, { name: 'T1' });
    await table(token, l2, { name: 'T1' });
    const res = await create(token, { locationId: l1, name: 'T1', seats: 2 }).expect(409);
    expect(res.body).toMatchObject({ code: 'pos.table_name_taken' });
    await patch(token, first.id, { archived: true }).expect(200);
    await table(token, l1, { name: 'T1' });
  });

  it('stores the look: square and neutral by default, changeable, validated', async () => {
    const { org, token } = await orgWith('owner');
    const plain = await table(token, org.locations[0]);
    expect(plain).toMatchObject({ shape: 'square', color: 'neutral' });
    const round = await table(token, org.locations[0], { shape: 'round', color: 'teal' });
    expect(round).toMatchObject({ shape: 'round', color: 'teal' });
    const changed = diningTableSchema.parse(
      (await patch(token, plain.id, { shape: 'long', color: 'rose' }).expect(200)).body,
    );
    expect(changed).toMatchObject({ shape: 'long', color: 'rose' });
    await patch(token, plain.id, { shape: 'oval' }).expect(400);
    await patch(token, plain.id, { color: '#ff0000' }).expect(400);
  });

  it('validates the body and the location', async () => {
    const { token } = await orgWith('owner');
    const { org: other } = await orgWith('owner');
    const { org } = await orgWith('owner');
    const ownToken = await memberToken(org, 'owner');
    for (const body of [
      { name: 'T', seats: 0 },
      { name: 'T', seats: 101 },
      { name: 'T', seats: 2.5 },
      { name: '', seats: 2 },
      { name: 'T', seats: 2, locationId: 'nope' },
    ]) {
      await create(ownToken, { locationId: org.locations[0], ...body }).expect(400);
    }
    const missing = await create(token, { locationId: uuidv7(), name: 'T', seats: 2 }).expect(404);
    expect(missing.body).toMatchObject({ code: 'pos.location_not_found' });
    // Another organization's location doesn't exist for this one (RLS).
    const foreign = await create(token, {
      locationId: other.locations[0],
      name: 'T',
      seats: 2,
    }).expect(404);
    expect(foreign.body).toMatchObject({ code: 'pos.location_not_found' });
  });

  describe('access', () => {
    it('lets staff read, managers and admins manage', async () => {
      const { org, token: owner } = await orgWith('owner');
      const t = await table(owner, org.locations[0]);
      const staff = await memberToken(org, 'staff');
      await list(staff).expect(200);
      const denied = await create(staff, {
        locationId: org.locations[0],
        name: 'S',
        seats: 2,
      }).expect(403);
      expect(denied.body).toMatchObject({
        code: 'rbac.permission_denied',
        details: { permission: 'pos.tables.manage' },
      });
      await patch(staff, t.id, { seats: 3 }).expect(403);
      for (const role of ['manager', 'admin'] as const) {
        const token = await memberToken(org, role);
        await table(token, org.locations[0]);
        await patch(token, t.id, { seats: 3 }).expect(200);
      }
    });

    it('limits a location-limited manager to their locations', async () => {
      const { org, token: owner } = await orgWith('owner');
      const [l1, l2] = org.locations;
      await table(owner, l1, { name: 'Mine' });
      const theirs = await table(owner, l2, { name: 'Theirs' });
      const manager = await memberToken(org, 'manager', [l1]);

      expect(await names(manager)).toEqual(['Mine']);
      expect(await names(manager, `?locationId=${l2}`)).toEqual([]);
      await table(manager, l1);
      await create(manager, { locationId: l2, name: 'X', seats: 2 }).expect(403);
      // A table at a location they can't read doesn't exist for them.
      const res = await patch(manager, theirs.id, { seats: 9 }).expect(404);
      expect(res.body).toMatchObject({ code: 'pos.table_not_found' });
    });

    it('needs the pos feature', async () => {
      const { org, token } = await orgWith('owner', 'inventory');
      const res = await list(token).expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
      await create(token, { locationId: org.locations[0], name: 'T', seats: 2 }).expect(403);
    });
  });

  it('replays a repeated create instead of creating twice', async () => {
    const { org, token } = await orgWith('owner');
    const key = uuidv7();
    const body = { locationId: org.locations[0], name: 'Once', seats: 2 };
    const first = await create(token, body, key).expect(201);
    const again = await create(token, body, key).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await seed.as(org.id, (db) => db.diningTable.count())).toBe(1);
  });

  it('records creates and changes in the audit log, and nothing for no-ops', async () => {
    const { org, token } = await orgWith('owner');
    const t = await table(token, org.locations[0], { name: 'T1', seats: 4 });
    await patch(token, t.id, { seats: 6 }).expect(200);
    await patch(token, t.id, { seats: 6 }).expect(200);
    await patch(token, t.id, { archived: true }).expect(200);
    const rows = await seed.as(org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'dining_table' },
        orderBy: { id: 'asc' },
        select: { action: true, before: true, after: true },
      }),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'pos.dining_table.created',
      'pos.dining_table.updated',
      'pos.dining_table.updated',
    ]);
    expect(rows[0]?.after).toEqual({
      id: t.id,
      locationId: org.locations[0],
      name: 'T1',
      seats: 4,
      area: null,
      shape: 'square',
      color: 'neutral',
      sortOrder: 0,
      archivedAt: null,
    });
    expect(rows[1]).toMatchObject({ before: { seats: 4 }, after: { seats: 6 } });
    expect(rows[2]).toMatchObject({ before: { archivedAt: null } });
    expect((rows[2]?.after as { archivedAt: string | null }).archivedAt).not.toBeNull();
  });

  it("never shows or changes another organization's tables", async () => {
    const { org: a, token: tokenA } = await orgWith('owner');
    const { token: tokenB } = await orgWith('owner');
    const t = await table(tokenA, a.locations[0], { name: 'Only A' });
    expect(await names(tokenB)).toEqual([]);
    expect(await names(tokenB, `?locationId=${a.locations[0]}`)).toEqual([]);
    const res = await patch(tokenB, t.id, { name: 'Taken' }).expect(404);
    expect(res.body).toMatchObject({ code: 'pos.table_not_found' });
    expect(await names(tokenA)).toEqual(['Only A']);
  });
});
