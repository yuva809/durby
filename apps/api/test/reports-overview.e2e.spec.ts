import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  overviewResponseSchema,
  productCategorySchema,
  productSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ReportsService } from '../src/modules/reports/reports.service';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reports.md → Overview (ADR 0082): facts at fixed times, at a fixed now: Tuesday 24 Nov 2026, 18:00 in
 * Berlin. Yesterday is Monday the 23rd; its normal day comes from the Mondays 16, 9 and 2 Nov and 26 Oct.
 */
const NOW = new Date('2026-11-24T17:00:00Z');

describe('/api/v1/reports/overview', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let now = NOW;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    // Only the reports' clock: sign-in keeps the real one.
    Object.assign(app.get(ReportsService), { clock: { now: () => now } });
  });

  beforeEach(() => {
    now = NOW;
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (token: string) =>
    request(server).get('/api/v1/reports/overview').auth(token, { type: 'bearer' });
  const overview = async (token: string) =>
    overviewResponseSchema.parse((await get(token).expect(200)).body);
  const post = (token: string, path: string, body: object = {}) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);
  const setSetting = (token: string, key: string, locationId: string, value: string) =>
    withIdempotencyKey(
      request(server)
        .put(`/api/v1/settings/${key}?locationId=${locationId}`)
        .auth(token, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ value })
      .expect(200);

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await member(org, 'owner');
    const [here, there] = org.locations;
    return { org, owner, here, there };
  }

  const place = (
    org: SeededOrg,
    name: string,
    extra: { archivedAt?: Date; isWarehouseSite?: boolean } = {},
  ) =>
    seed.as(org.id, async (db) => {
      const brand = await db.brand.findFirstOrThrow();
      return (
        await db.location.create({
          data: { tenantId: org.id, brandId: brand.id, name, ...extra },
        })
      ).id;
    });

  /** One order sent at `at`; `null` = everything on it was voided. */
  async function sold(org: SeededOrg, locationId: string, at: string, gross: string | null) {
    const orderId = uuidv7();
    await seed.as(org.id, async (db) => {
      await db.reportOrderFact.create({
        data: {
          tenantId: org.id,
          locationId,
          orderId,
          tableId: uuidv7(),
          openedAt: new Date(at),
          rounds: gross === null ? 0 : 1,
          firstSentAt: gross === null ? null : new Date(at),
        },
      });
      if (gross !== null) {
        await db.reportLineFact.create({
          data: {
            tenantId: org.id,
            locationId,
            orderId,
            lineId: uuidv7(),
            productId: uuidv7(),
            quantity: 1,
            gross,
            sentAt: new Date(at),
          },
        });
      }
    });
  }

  it('shows today and yesterday against a normal day, per location and in total', async () => {
    const s = await setup();
    const third = await place(s.org, 'L3');
    const at = (location: string) => (when: string, gross: string | null) =>
      sold(s.org, location, when, gross);
    const here = at(s.here);
    await here('2026-11-24T10:00:00Z', '30.00'); // today
    await here('2026-11-24T03:00:00Z', '10.00'); // 04:00 in Berlin: today
    await here('2026-11-24T17:00:00Z', '99.00'); // not yet
    await here('2026-11-17T12:00:00Z', '20.00'); // last Tuesday before 18:00
    await here('2026-11-17T18:00:00Z', '500.00'); // after 18:00
    await here('2026-11-23T12:00:00Z', '50.00'); // yesterday
    await here('2026-11-24T00:30:00Z', '7.00'); // 01:30 today: still yesterday
    await here('2026-11-16T12:00:00Z', '40.00'); // four Mondays: 60, 40, 50.01, 0
    await here('2026-11-17T00:30:00Z', '20.00'); // 01:30: still Monday the 16th
    await here('2026-11-09T12:00:00Z', '40.00');
    await here('2026-11-02T12:00:00Z', '50.01');
    await here('2026-10-26T12:00:00Z', '0.00'); // all discounted: an ordinary day with zero sales
    await here('2026-10-19T12:00:00Z', '999.00'); // five weeks back
    await here('2026-11-22T12:00:00Z', '999.00'); // Sunday
    const there = at(s.there);
    await there('2026-11-24T11:00:00Z', '5.00'); // today; nothing last week
    await there('2026-11-23T12:00:00Z', '10.00');
    await there('2026-11-16T12:00:00Z', '20.00');
    await there('2026-11-09T12:00:00Z', '30.00');
    await there('2026-11-09T13:00:00Z', '10.00');
    await there('2026-11-02T12:00:00Z', null); // everything voided: not a day with orders
    await sold(s.org, third, '2026-11-23T12:00:00Z', '5.00'); // no Monday to compare with

    const res = await overview(s.owner);
    expect(res).toMatchObject({ currency: 'EUR', asOf: NOW.toISOString(), hasData: true });
    expect(res.locations).toEqual([
      {
        locationId: s.here,
        name: 'L1',
        today: {
          gross: '40.00',
          items: 2,
          orders: 2,
          averageOrder: '20.00',
          openTables: 0,
          changePercent: '100.0',
        },
        yesterday: {
          day: '2026-11-23',
          gross: '57.00',
          orders: 2,
          // (60 + 40 + 50.01 + 0) / 4
          normal: { gross: '37.50', days: 4, difference: '19.50', changePercent: '52.0' },
        },
      },
      {
        locationId: s.there,
        name: 'L2',
        today: {
          gross: '5.00',
          items: 1,
          orders: 1,
          averageOrder: '5.00',
          openTables: 0,
          changePercent: null,
        },
        yesterday: {
          day: '2026-11-23',
          gross: '10.00',
          orders: 1,
          // (20 + 40) / 2
          normal: { gross: '30.00', days: 2, difference: '-20.00', changePercent: '-66.7' },
        },
      },
      {
        locationId: third,
        name: 'L3',
        today: {
          gross: '0.00',
          items: 0,
          orders: 0,
          averageOrder: null,
          openTables: 0,
          changePercent: null,
        },
        yesterday: { day: '2026-11-23', gross: '5.00', orders: 1, normal: null },
      },
    ]);
    expect(res.total).toEqual({
      today: {
        gross: '45.00',
        items: 3,
        orders: 3,
        averageOrder: '15.00',
        openTables: 0,
        changePercent: '125.0',
      },
      yesterday: {
        gross: '72.00',
        orders: 4,
        // Without L3, which has no normal day: 67 against 67.50.
        normal: { gross: '67.50', compared: '67.00', difference: '-0.50', changePercent: '-0.7' },
        leftOut: 1,
      },
    });
  });

  it('uses three days when one Monday had no orders, and no percent of zero', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-16T12:00:00Z', '10.00');
    await sold(s.org, s.here, '2026-11-09T12:00:00Z', '10.00');
    await sold(s.org, s.here, '2026-11-02T12:00:00Z', '20.00');
    await sold(s.org, s.there, '2026-11-16T12:00:00Z', '0.00');
    const res = await overview(s.owner);
    expect(res.locations.map((l) => l.yesterday)).toEqual([
      {
        day: '2026-11-23',
        gross: '0.00',
        orders: 0,
        normal: { gross: '13.33', days: 3, difference: '-13.33', changePercent: '-100.0' },
      },
      {
        day: '2026-11-23',
        gross: '0.00',
        orders: 0,
        normal: { gross: '0.00', days: 1, difference: '0.00', changePercent: null },
      },
    ]);
  });

  it('says when there is nothing yet', async () => {
    const s = await setup();
    const res = await overview(s.owner);
    expect(res.hasData).toBe(false);
    expect(res.locations).toHaveLength(2);
    expect(res.total.yesterday).toEqual({ gross: '0.00', orders: 0, normal: null, leftOut: 2 });
    expect(res.total.today.changePercent).toBeNull();
  });

  it('gives each location its own day start and zone', async () => {
    const s = await setup();
    await setSetting(s.owner, 'timezone', s.there, 'America/New_York');
    await setSetting(s.owner, 'reports.dayStartsAt', s.here, '00:00');
    // 08:30 UTC on the 24th: today in Berlin, still the 23rd in New York (03:30).
    await sold(s.org, s.here, '2026-11-24T08:30:00Z', '1.00');
    await sold(s.org, s.there, '2026-11-24T08:30:00Z', '2.00');
    // 00:30 in Berlin on the 24th: today there, as that day starts at midnight.
    await sold(s.org, s.here, '2026-11-23T23:30:00Z', '4.00');
    let res = await overview(s.owner);
    expect(res.locations.map((l) => [l.today.gross, l.yesterday.gross])).toEqual([
      ['5.00', '0.00'],
      ['0.00', '2.00'],
    ]);
    // At 06:00 in Berlin it is midnight in New York: a different yesterday.
    now = new Date('2026-11-24T05:00:00Z');
    res = await overview(s.owner);
    expect(res.locations.map((l) => l.yesterday.day)).toEqual(['2026-11-23', '2026-11-22']);
  });

  it('averages whole business days across the autumn switch', async () => {
    const s = await setup();
    now = new Date('2026-11-01T12:00:00Z'); // Sunday; yesterday Saturday 31 Oct
    // The 25-hour Saturday ends on Sunday the 25th at 04:00 winter time (03:00 UTC).
    await sold(s.org, s.here, '2026-10-25T02:59:59Z', '10.00');
    await sold(s.org, s.here, '2026-10-25T03:00:00Z', '900.00');
    // Before the switch the day ends at 02:00 UTC.
    await sold(s.org, s.here, '2026-10-18T01:59:59Z', '20.00');
    await sold(s.org, s.here, '2026-10-18T02:00:00Z', '900.00');
    const [first] = (await overview(s.owner)).locations;
    expect(first?.yesterday).toMatchObject({
      day: '2026-10-31',
      normal: { gross: '15.00', days: 2 },
    });
  });

  it('counts the tables open now', async () => {
    const s = await setup();
    const category = productCategorySchema.parse(
      (await post(s.owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const product = productSchema.parse(
      (
        await post(s.owner, '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '5.00',
          taxRate: '7',
        }).expect(201)
      ).body,
    );
    for (const [locationId, name] of [
      [s.here, 'A'],
      [s.here, 'B'],
      [s.there, 'C'],
    ] as const) {
      const table = diningTableSchema.parse(
        (await post(s.owner, '/pos/tables', { locationId, name, seats: 2 }).expect(201)).body,
      );
      await post(s.owner, `/pos/tables/${table.id}/tickets`, {
        lines: [{ productId: product.id, quantity: 1 }],
      }).expect(201);
    }
    const res = await overview(s.owner);
    expect(res.locations.map((l) => l.today.openTables)).toEqual([2, 1]);
    expect(res.total.today.openTables).toBe(3);
  });

  it('leaves out archived locations and warehouse sites, sorted by name', async () => {
    const s = await setup();
    const archived = await place(s.org, 'Old', { archivedAt: new Date() });
    const depot = await place(s.org, 'Depot', { isWarehouseSite: true });
    const first = await place(s.org, 'Airport');
    for (const id of [archived, depot]) await sold(s.org, id, '2026-11-24T10:00:00Z', '100.00');
    const res = await overview(s.owner);
    expect(res.locations.map((l) => l.locationId)).toEqual([first, s.here, s.there]);
    expect(res.total.today.gross).toBe('0.00');
    expect(res.hasData).toBe(false);
  });

  it('limits a manager to their locations and refuses everyone else', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-24T10:00:00Z', '1.00');
    await sold(s.org, s.there, '2026-11-24T10:00:00Z', '2.00');
    await sold(s.org, s.here, '2026-11-23T10:00:00Z', '4.00');
    const limited = await overview(await member(s.org, 'manager', [s.there]));
    expect(limited.locations.map((l) => l.locationId)).toEqual([s.there]);
    expect(limited.total.today.gross).toBe('2.00');
    expect(limited.total.yesterday).toMatchObject({ gross: '0.00', leftOut: 1 });
    expect((await overview(await member(s.org, 'manager'))).total.today.gross).toBe('3.00');
    expect((await overview(await member(s.org, 'admin'))).total.today.gross).toBe('3.00');
    for (const role of ['staff', 'waiter', 'cashier', 'host', 'kitchen', 'bar'] as const) {
      await get(await member(s.org, role)).expect(403);
    }
  });

  it('shows another organization nothing', async () => {
    const s = await setup();
    const other = await setup();
    await sold(s.org, s.here, '2026-11-24T10:00:00Z', '1.00');
    const res = await overview(other.owner);
    expect(res.total.today.gross).toBe('0.00');
    expect(res.hasData).toBe(false);
    expect(res.locations.map((l) => l.locationId).sort()).toEqual([...other.org.locations].sort());
  });

  it('needs reports and the till', async () => {
    const s = await setup();
    const set = (feature: string, on: boolean) =>
      entitlements.setOverride(s.org.id, feature, on, undefined, 'cli.entitlements');
    await set('reports', false);
    expect(((await get(s.owner).expect(403)).body as { code: string }).code).toBe(
      'entitlements.feature_disabled',
    );
    const t = await setup();
    await entitlements.setOverride(t.org.id, 'reservations', false, undefined, 'cli.entitlements');
    await get(t.owner).expect(200);
    await entitlements.setOverride(t.org.id, 'pos', false, undefined, 'cli.entitlements');
    expect(((await get(t.owner).expect(403)).body as { code: string }).code).toBe(
      'entitlements.feature_disabled',
    );
  });
});
