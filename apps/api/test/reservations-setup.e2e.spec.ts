import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  reservationCombinationSchema,
  reservationCombinationsResponseSchema,
  reservationTableSchema,
  reservationTablesResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R1.5 setup API: table rules and combinations per location.
 */
describe('reservations setup: table rules and combinations', () => {
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
  const send = (
    token: string,
    method: 'post' | 'put' | 'patch',
    path: string,
    body: unknown,
    key = uuidv7(),
  ) =>
    request(server)
      [method](`/api/v1${path}`)
      .set('Idempotency-Key', key)
      .auth(token, { type: 'bearer' })
      .send(body as object);

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    there: string;
    t2: string;
    t4: string;
    t6: string;
    archived: string;
    elsewhere: string;
  }

  /** On `full`: a 2-, 4- and 6-top and an archived table here, one table at the second location. */
  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    const table = async (locationId: string, name: string, seats: number, sortOrder: number) =>
      diningTableSchema.parse(
        (
          await send(owner, 'post', '/pos/tables', { locationId, name, seats, sortOrder }).expect(
            201,
          )
        ).body,
      ).id;
    const t2 = await table(here, 'T2', 2, 1);
    const t4 = await table(here, 'T4', 4, 2);
    const t6 = await table(here, 'T6', 6, 3);
    const archived = await table(here, 'Old', 4, 4);
    await send(owner, 'patch', `/pos/tables/${archived}`, { archived: true }).expect(200);
    const elsewhere = await table(there, 'T9', 4, 1);
    return { org, owner, here, there, t2, t4, t6, archived, elsewhere };
  }

  const tables = async (token: string, locationId: string) =>
    reservationTablesResponseSchema.parse(
      (await get(token, `/reservations/tables?locationId=${locationId}`).expect(200)).body,
    ).data;
  const combinations = async (token: string, locationId: string, archived = false) =>
    reservationCombinationsResponseSchema.parse(
      (
        await get(
          token,
          `/reservations/combinations?locationId=${locationId}${archived ? '&includeArchived=true' : ''}`,
        ).expect(200)
      ).body,
    ).data;
  const putRule = (token: string, tableId: string, body: unknown, key?: string) =>
    send(token, 'put', `/reservations/tables/${tableId}/rule`, body, key);
  const combine = (token: string, body: unknown, key?: string) =>
    send(token, 'post', '/reservations/combinations', body, key);
  const auditRows = (orgId: string, entityType: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: { entityType },
        orderBy: { id: 'asc' },
        select: { action: true, entityId: true, before: true, after: true },
      }),
    );

  describe('table rules', () => {
    it('lists the tables in service with default rules, then the stored rule', async () => {
      const r = await restaurant();
      const list = await tables(r.owner, r.here);
      expect(list.map((t) => t.name)).toEqual(['T2', 'T4', 'T6']); // not the archived one
      expect(list[2]).toMatchObject({
        id: r.t6,
        locationId: r.here,
        seats: 6,
        bookingMode: 'all',
        minParty: 1,
        maxParty: null,
      });
      const saved = reservationTableSchema.parse(
        (
          await putRule(r.owner, r.t6, {
            bookingMode: 'staff_only',
            minParty: 4,
            maxParty: null,
          }).expect(200)
        ).body,
      );
      expect(saved).toMatchObject({ id: r.t6, bookingMode: 'staff_only', minParty: 4 });
      expect((await tables(r.owner, r.here))[2]).toEqual(saved);
      expect(await tables(r.owner, r.there)).toHaveLength(1);
    });

    it('lets a max party exceed the seats, but not a min party above the capacity', async () => {
      const r = await restaurant();
      await putRule(r.owner, r.t4, { bookingMode: 'all', minParty: 2, maxParty: 5 }).expect(200);
      for (const body of [
        { bookingMode: 'all', minParty: 5, maxParty: null }, // above 4 seats
        { bookingMode: 'all', minParty: 4, maxParty: 3 }, // min > max
      ]) {
        const res = await putRule(r.owner, r.t4, body).expect(422);
        expect(res.body).toMatchObject({ code: 'reservations.party_range_invalid' });
      }
      for (const body of [
        { bookingMode: 'sometimes', minParty: 1, maxParty: null },
        { bookingMode: 'all', minParty: 0, maxParty: null },
        { bookingMode: 'all', minParty: 1, maxParty: 101 },
        { bookingMode: 'all', minParty: 1 },
        { bookingMode: 'all', minParty: 1, maxParty: null, extra: true },
      ]) {
        await putRule(r.owner, r.t4, body).expect(400);
      }
    });

    it('answers 404 for unknown, archived and other locations’ tables it may not manage', async () => {
      const r = await restaurant();
      const body = { bookingMode: 'all', minParty: 1, maxParty: null };
      for (const id of [uuidv7(), r.archived]) {
        const res = await putRule(r.owner, id, body).expect(404);
        expect(res.body).toMatchObject({ code: 'reservations.table_not_found' });
      }
      await putRule(r.owner, 'nope', body).expect(404);
      const limited = await memberToken(r.org, 'manager', [r.there]);
      await putRule(limited, r.t2, body).expect(404);
      await putRule(limited, r.elsewhere, body).expect(200);
    });

    it('replays a repeated PUT and audits changes only', async () => {
      const r = await restaurant();
      const key = uuidv7();
      const body = { bookingMode: 'walk_in_only', minParty: 1, maxParty: 2 };
      const first = await putRule(r.owner, r.t2, body, key).expect(200);
      const again = await putRule(r.owner, r.t2, body, key).expect(200);
      expect(again.body).toEqual(first.body);
      await putRule(r.owner, r.t2, body).expect(200); // same values: no audit row
      await putRule(r.owner, r.t2, { ...body, bookingMode: 'all' }).expect(200);
      const rows = await auditRows(r.org.id, 'reservation_table_rule');
      expect(rows).toEqual([
        {
          action: 'reservations.table_rule.updated',
          entityId: r.t2,
          before: null,
          after: { tableId: r.t2, bookingMode: 'walk_in_only', minParty: 1, maxParty: 2 },
        },
        {
          action: 'reservations.table_rule.updated',
          entityId: r.t2,
          before: { tableId: r.t2, bookingMode: 'walk_in_only', minParty: 1, maxParty: 2 },
          after: { tableId: r.t2, bookingMode: 'all', minParty: 1, maxParty: 2 },
        },
      ]);
    });
  });

  describe('combinations', () => {
    const body = (r: Restaurant) => ({
      locationId: r.here,
      name: ' T4+T6 ',
      tableIds: [r.t6, r.t4],
      minParty: 7,
      maxParty: 10,
    });

    it('creates, lists, edits, archives and restores a combination', async () => {
      const r = await restaurant();
      const created = reservationCombinationSchema.parse(
        (await combine(r.owner, body(r)).expect(201)).body,
      );
      expect(created).toMatchObject({
        locationId: r.here,
        name: 'T4+T6',
        tableIds: [r.t4, r.t6].sort(),
        minParty: 7,
        maxParty: 10,
        onlineBookable: true,
        archivedAt: null,
      });
      expect(await combinations(r.owner, r.here)).toEqual([created]);
      expect(await combinations(r.owner, r.there)).toEqual([]);

      const patch = (b: unknown) =>
        send(r.owner, 'patch', `/reservations/combinations/${created.id}`, b);
      const edited = reservationCombinationSchema.parse(
        (
          await patch({ name: 'Big', tableIds: [r.t2, r.t4, r.t6], onlineBookable: false }).expect(
            200,
          )
        ).body,
      );
      expect(edited).toMatchObject({
        name: 'Big',
        tableIds: [r.t2, r.t4, r.t6].sort(),
        onlineBookable: false,
      });
      await patch({ archived: true }).expect(200);
      expect(await combinations(r.owner, r.here)).toEqual([]);
      const [archived] = await combinations(r.owner, r.here, true);
      expect(archived?.archivedAt).not.toBeNull();
      await patch({ archived: false }).expect(200);
      expect((await combinations(r.owner, r.here))[0]).toMatchObject({ archivedAt: null });
    });

    it('validates tables, sizes and names', async () => {
      const r = await restaurant();
      for (const tableIds of [
        [r.t4, r.elsewhere],
        [r.t4, r.archived],
        [r.t4, uuidv7()],
      ]) {
        const res = await combine(r.owner, { ...body(r), tableIds }).expect(404);
        expect(res.body).toMatchObject({ code: 'reservations.table_not_found' });
      }
      for (const b of [
        { ...body(r), tableIds: [r.t4] },
        { ...body(r), tableIds: [r.t4, r.t4] },
        { ...body(r), name: '   ' },
        { ...body(r), name: 'x'.repeat(61) },
        { ...body(r), maxParty: 101 },
        { ...body(r), minParty: 0 },
      ]) {
        await combine(r.owner, b).expect(400);
      }
      const res = await combine(r.owner, { ...body(r), minParty: 11 }).expect(422);
      expect(res.body).toMatchObject({ code: 'reservations.party_range_invalid' });
      // A patch is checked against the stored values.
      const c = reservationCombinationSchema.parse(
        (await combine(r.owner, body(r)).expect(201)).body,
      );
      await send(r.owner, 'patch', `/reservations/combinations/${c.id}`, { minParty: 11 }).expect(
        422,
      );
      await send(r.owner, 'patch', `/reservations/combinations/${c.id}`, {
        tableIds: [r.t4, r.archived],
      }).expect(404);
      await send(r.owner, 'patch', `/reservations/combinations/${c.id}`, {}).expect(400);
    });

    it('replays a repeated create and audits create and change', async () => {
      const r = await restaurant();
      const key = uuidv7();
      const first = await combine(r.owner, body(r), key).expect(201);
      const again = await combine(r.owner, body(r), key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await combinations(r.owner, r.here)).toHaveLength(1);
      const id = reservationCombinationSchema.parse(first.body).id;
      await send(r.owner, 'patch', `/reservations/combinations/${id}`, { maxParty: 9 }).expect(200);
      await send(r.owner, 'patch', `/reservations/combinations/${id}`, { maxParty: 9 }).expect(200); // no-op
      const rows = await auditRows(r.org.id, 'reservation_combination');
      expect(rows.map((x) => x.action)).toEqual([
        'reservations.combination.created',
        'reservations.combination.updated',
      ]);
      expect(rows[0]?.after).toEqual({
        id,
        locationId: r.here,
        name: 'T4+T6',
        tableIds: [r.t4, r.t6].sort(),
        minParty: 7,
        maxParty: 10,
        onlineBookable: true,
        archivedAt: null,
      });
      expect(rows[1]).toMatchObject({ before: { maxParty: 10 }, after: { maxParty: 9 } });
    });
  });

  describe('access', () => {
    it('lets managers and admins set up; waiters and hosts read; staff and cashiers neither', async () => {
      const r = await restaurant();
      const rule = { bookingMode: 'all', minParty: 1, maxParty: null };
      for (const role of ['manager', 'admin'] as const) {
        const token = await memberToken(r.org, role);
        await putRule(token, r.t2, rule).expect(200);
        await combine(token, {
          locationId: r.here,
          name: role,
          tableIds: [r.t2, r.t4],
          minParty: 3,
          maxParty: 6,
        }).expect(201);
      }
      for (const role of ['waiter', 'host'] as const) {
        const token = await memberToken(r.org, role);
        await tables(token, r.here);
        await combinations(token, r.here);
        const res = await putRule(token, r.t2, rule).expect(403);
        expect(res.body).toMatchObject({ details: { permission: 'reservations.setup.manage' } });
        await combine(token, {
          locationId: r.here,
          name: 'X',
          tableIds: [r.t2, r.t4],
          minParty: 3,
          maxParty: 6,
        }).expect(403);
      }
      for (const role of ['staff', 'cashier'] as const) {
        const token = await memberToken(r.org, role);
        await get(token, `/reservations/tables?locationId=${r.here}`).expect(403);
        await get(token, `/reservations/combinations?locationId=${r.here}`).expect(403);
      }
    });

    it('hides other locations from location-limited members', async () => {
      const r = await restaurant();
      const c = reservationCombinationSchema.parse(
        (
          await combine(r.owner, {
            locationId: r.here,
            name: 'Here',
            tableIds: [r.t2, r.t4],
            minParty: 3,
            maxParty: 6,
          }).expect(201)
        ).body,
      );
      const limited = await memberToken(r.org, 'manager', [r.there]);
      for (const path of ['tables', 'combinations']) {
        const res = await get(limited, `/reservations/${path}?locationId=${r.here}`).expect(404);
        expect(res.body).toMatchObject({ code: 'reservations.location_not_found' });
      }
      const patched = await send(limited, 'patch', `/reservations/combinations/${c.id}`, {
        name: 'Taken',
      }).expect(404);
      expect(patched.body).toMatchObject({ code: 'reservations.combination_not_found' });
      await combine(limited, {
        locationId: r.here,
        name: 'X',
        tableIds: [r.t2, r.t4],
        minParty: 3,
        maxParty: 6,
      }).expect(404);
    });

    it("never shows or changes another organization's tables and combinations", async () => {
      const a = await restaurant();
      const b = await restaurant();
      const c = reservationCombinationSchema.parse(
        (
          await combine(a.owner, {
            locationId: a.here,
            name: 'A',
            tableIds: [a.t2, a.t4],
            minParty: 3,
            maxParty: 6,
          }).expect(201)
        ).body,
      );
      for (const path of ['tables', 'combinations']) {
        const res = await get(b.owner, `/reservations/${path}?locationId=${a.here}`).expect(404);
        expect(res.body).toMatchObject({ code: 'reservations.location_not_found' });
      }
      await putRule(b.owner, a.t2, { bookingMode: 'all', minParty: 1, maxParty: null }).expect(404);
      await send(b.owner, 'patch', `/reservations/combinations/${c.id}`, { name: 'B' }).expect(404);
      // Nor combine A's tables at B's location.
      await combine(b.owner, {
        locationId: b.here,
        name: 'Mixed',
        tableIds: [b.t2, a.t4],
        minParty: 3,
        maxParty: 6,
      }).expect(404);
      expect(await combinations(a.owner, a.here)).toEqual([c]);
    });

    it('needs the reservations feature', async () => {
      const r = await restaurant();
      await entitlements.setOverride(
        r.org.id,
        'reservations',
        false,
        undefined,
        'cli.entitlements',
      );
      for (const res of [
        await get(r.owner, `/reservations/tables?locationId=${r.here}`),
        await putRule(r.owner, r.t2, { bookingMode: 'all', minParty: 1, maxParty: null }),
        await get(r.owner, `/reservations/combinations?locationId=${r.here}`),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
      }
    });
  });
});
