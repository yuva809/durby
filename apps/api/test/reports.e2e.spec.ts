import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  productCategorySchema,
  productSchema,
  reservationsReportResponseSchema,
  salesCategoriesResponseSchema,
  salesHoursResponseSchema,
  salesItemsResponseSchema,
  salesSummaryResponseSchema,
  sendTicketResponseSchema,
  type SystemRole,
  tablesReportResponseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ReportsService } from '../src/modules/reports/reports.service';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/reports.md: figures from facts at fixed times, at a fixed now: Tuesday 24 Nov 2026, 18:00 in Berlin. */
const NOW = new Date('2026-11-24T17:00:00Z');

describe('/api/v1/reports', () => {
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
    // Only the reports' clock: sign-in keeps the real one.
    Object.assign(app.get(ReportsService), { clock: { now: () => NOW } });
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: object = {}) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);
  const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

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
    const category = async (name: string) =>
      productCategorySchema.parse(
        (await post(owner, '/catalog/categories', { name }).expect(201)).body,
      ).id;
    const product = async (categoryId: string, name: string) =>
      productSchema.parse(
        (
          await post(owner, '/catalog/products', {
            categoryId,
            name,
            price: '5.00',
            taxRate: '7',
          }).expect(201)
        ).body,
      ).id;
    const table = async (locationId: string, name: string) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4 }).expect(201)).body,
      ).id;
    const food = await category('Food');
    const drinks = await category('Drinks');
    return {
      org,
      owner,
      here,
      there,
      food,
      drinks,
      soup: await product(food, 'Soup'),
      steak: await product(food, 'Steak'),
      cola: await product(drinks, 'Cola'),
      t1: await table(here, 'T1'),
      t2: await table(here, 'T2'),
      far: await table(there, 'F1'),
    };
  }

  /** One order with its lines, all sent at `at`. */
  async function order(
    org: SeededOrg,
    locationId: string,
    at: string,
    lines: [productId: string, quantity: number, gross: string][],
    extra: {
      rounds?: number;
      tableId?: string;
      closedAt?: string;
      mergedAway?: boolean;
    } = {},
  ) {
    const orderId = uuidv7();
    await seed.as(org.id, async (db) => {
      await db.reportOrderFact.create({
        data: {
          tenantId: org.id,
          locationId,
          orderId,
          tableId: extra.tableId ?? uuidv7(),
          openedAt: new Date(at),
          closedAt: extra.closedAt ? new Date(extra.closedAt) : null,
          mergedAway: extra.mergedAway ?? false,
          rounds: extra.rounds ?? 1,
          firstSentAt: lines.length > 0 ? new Date(at) : null,
        },
      });
      if (lines.length > 0) {
        await db.reportLineFact.createMany({
          data: lines.map(([productId, quantity, gross]) => ({
            tenantId: org.id,
            locationId,
            orderId,
            lineId: uuidv7(),
            productId,
            quantity,
            gross,
            sentAt: new Date(at),
          })),
        });
      }
    });
  }

  const period = '?from=2026-11-24&to=2026-11-24';
  const summary = async (token: string, query = period) =>
    salesSummaryResponseSchema.parse(
      (await get(token, `/reports/sales/summary${query}`).expect(200)).body,
    );

  it('cards compare with the same weekday; a day starts at 04:00 of the location', async () => {
    const s = await setup();
    const sold = (at: string, gross: string) => order(s.org, s.here, at, [[s.soup, 1, gross]]);
    await sold('2026-11-24T10:00:00Z', '30.00'); // today
    await sold('2026-11-24T02:59:59Z', '7.00'); // 03:59 in Berlin: still Monday, yesterday
    await sold('2026-11-24T03:00:00Z', '10.00'); // 04:00: today
    await sold('2026-11-24T17:00:00Z', '99.00'); // not yet (the end is excluded)
    await sold('2026-11-23T12:00:00Z', '50.00'); // yesterday, Monday
    await sold('2026-11-17T12:00:00Z', '20.00'); // last Tuesday, before 18:00
    await sold('2026-11-17T18:00:00Z', '500.00'); // last Tuesday, after 18:00
    await sold('2026-11-16T12:00:00Z', '60.00'); // last Monday

    const res = await summary(s.owner);
    expect(res.currency).toBe('EUR');
    const card = (key: string) => res.cards.find((c) => c.key === key);
    expect(card('today')).toEqual({
      key: 'today',
      figures: { gross: '40.00', items: 2, orders: 2, averageOrder: '20.00' },
      compare: { gross: '20.00', items: 1, orders: 1, averageOrder: '20.00' },
      changePercent: '100.0',
    });
    expect(card('yesterday')).toMatchObject({
      figures: { gross: '57.00', orders: 2 },
      compare: { gross: '60.00', orders: 1 },
      changePercent: '-5.0',
    });
    // Monday and Tuesday so far against last week's up to Tuesday 18:00: 97 against 80.
    expect(card('week')).toMatchObject({
      figures: { gross: '97.00', orders: 4 },
      compare: { gross: '80.00', orders: 2 },
      changePercent: '21.3',
    });
    // The whole business day, also what comes after now.
    expect(res.period).toMatchObject({ gross: '139.00', orders: 3 });
  });

  it('has no change without anything to compare with', async () => {
    const s = await setup();
    await order(s.org, s.here, '2026-11-24T10:00:00Z', [[s.soup, 1, '5.00']]);
    const res = await summary(s.owner);
    expect(res.cards.map((c) => c.changePercent)).toEqual([null, null, null]);
    expect((await summary(s.owner, '?from=2026-01-01&to=2026-01-31')).period).toEqual({
      gross: '0.00',
      items: 0,
      orders: 0,
      averageOrder: null,
      secondRoundOrders: 0,
      secondRoundRate: null,
    });
  });

  it('counts second rounds', async () => {
    const s = await setup();
    const at = '2026-11-24T10:00:00Z';
    await order(s.org, s.here, at, [[s.soup, 1, '5.00']], { rounds: 1 });
    await order(s.org, s.here, at, [[s.soup, 1, '5.00']], { rounds: 2 });
    await order(s.org, s.here, at, [[s.soup, 1, '5.00']], { rounds: 3 });
    await order(s.org, s.here, at, [], { rounds: 0 }); // everything voided: no order
    expect((await summary(s.owner)).period).toMatchObject({
      orders: 3,
      secondRoundOrders: 2,
      secondRoundRate: '66.7',
    });
  });

  it('each location counts by its own day start and zone', async () => {
    const s = await setup();
    await withIdempotencyKey(
      request(server)
        .put(`/api/v1/settings/timezone?locationId=${s.there}`)
        .auth(s.owner, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ value: 'America/New_York' })
      .expect(200);
    // 08:30 UTC on the 24th: 09:30 in Berlin (the 24th), 03:30 in New York (still the 23rd).
    await order(s.org, s.here, '2026-11-24T08:30:00Z', [[s.soup, 1, '1.00']]);
    await order(s.org, s.there, '2026-11-24T08:30:00Z', [[s.soup, 1, '2.00']]);
    expect((await summary(s.owner)).period.gross).toBe('1.00');
    expect((await summary(s.owner, '?from=2026-11-23&to=2026-11-23')).period.gross).toBe('2.00');
    const hours = salesHoursResponseSchema.parse(
      (await get(s.owner, '/reports/sales/hours?from=2026-11-23&to=2026-11-24').expect(200)).body,
    );
    expect(hours.data.filter((h) => h.items > 0)).toEqual([
      { hour: 3, gross: '2.00', items: 1, orders: 1 },
      { hour: 9, gross: '1.00', items: 1, orders: 1 },
    ]);
  });

  it('lists hours, items and categories', async () => {
    const s = await setup();
    await order(s.org, s.here, '2026-11-24T11:10:00Z', [
      [s.soup, 3, '15.00'],
      [s.cola, 1, '5.00'],
    ]);
    await order(s.org, s.there, '2026-11-24T11:50:00Z', [[s.steak, 1, '20.00']]);
    const hours = salesHoursResponseSchema.parse(
      (await get(s.owner, `/reports/sales/hours${period}`).expect(200)).body,
    );
    expect(hours.data).toHaveLength(24);
    expect(hours.data[12]).toEqual({ hour: 12, gross: '40.00', items: 5, orders: 2 });
    expect(hours.data[13]).toEqual({ hour: 13, gross: '0.00', items: 0, orders: 0 });

    const items = salesItemsResponseSchema.parse(
      (await get(s.owner, `/reports/sales/items${period}`).expect(200)).body,
    );
    expect(items.data.map((i) => [i.name, i.categoryName, i.quantity, i.gross])).toEqual([
      ['Soup', 'Food', 3, '15.00'],
      ['Steak', 'Food', 1, '20.00'],
      ['Cola', 'Drinks', 1, '5.00'],
    ]);
    const categories = salesCategoriesResponseSchema.parse(
      (await get(s.owner, `/reports/sales/categories${period}`).expect(200)).body,
    );
    expect(categories.data).toEqual([
      { categoryId: s.food, name: 'Food', quantity: 4, gross: '35.00', share: '87.5' },
      { categoryId: s.drinks, name: 'Drinks', quantity: 1, gross: '5.00', share: '12.5' },
    ]);
    // One location only.
    const one = salesItemsResponseSchema.parse(
      (await get(s.owner, `/reports/sales/items${period}&locationId=${s.there}`).expect(200)).body,
    );
    expect(one.data.map((i) => i.name)).toEqual(['Steak']);
  });

  it('shows table times without merged orders, and the tables open now', async () => {
    const s = await setup();
    const closed = (tableId: string, minutes: number, extra = {}) =>
      order(s.org, s.here, '2026-11-24T11:00:00Z', [[s.soup, 1, '5.00']], {
        tableId,
        closedAt: new Date(Date.UTC(2026, 10, 24, 11, minutes)).toISOString(),
        ...extra,
      });
    await closed(s.t1, 30);
    await closed(s.t1, 60);
    await closed(s.t2, 90);
    await closed(s.t2, 5, { mergedAway: true });
    const opened = sendTicketResponseSchema.parse(
      (
        await post(s.owner, `/pos/tables/${s.t1}/tickets`, {
          lines: [{ productId: s.soup, quantity: 1 }],
          covers: 2,
        }).expect(201)
      ).body,
    ).order;
    const res = tablesReportResponseSchema.parse(
      (await get(s.owner, `/reports/tables${period}`).expect(200)).body,
    );
    expect(res).toMatchObject({ orders: 3, averageMinutes: 60 });
    expect(res.tables.map((t) => [t.name, t.orders, t.averageMinutes])).toEqual([
      ['T2', 1, 90],
      ['T1', 2, 45],
    ]);
    expect(res.open).toEqual([
      { tableId: s.t1, locationId: s.here, name: 'T1', openedAt: opened.openedAt, covers: 2 },
    ]);
  });

  it('reports covers, no-shows and turn times', async () => {
    const s = await setup();
    const booking = (
      partySize: number,
      status: 'seated' | 'finished' | 'no_show' | 'cancelled' | 'declined' | 'booked',
      source: 'staff' | 'online' | 'walk_in' = 'staff',
      minutes?: number,
    ) =>
      seed.as(s.org.id, (db) =>
        db.reportReservationFact.create({
          data: {
            tenantId: s.org.id,
            locationId: s.here,
            reservationId: uuidv7(),
            startsAt: new Date('2026-11-24T18:00:00Z'),
            status,
            source,
            partySize,
            seatedAt: minutes === undefined ? null : new Date('2026-11-24T18:00:00Z'),
            finishedAt:
              minutes === undefined ? null : new Date(Date.UTC(2026, 10, 24, 18, minutes)),
          },
        }),
      );
    await booking(2, 'finished', 'staff', 60);
    await booking(2, 'finished', 'online', 90);
    await booking(5, 'finished', 'walk_in', 120);
    await booking(4, 'seated');
    await booking(3, 'no_show', 'online');
    await booking(9, 'cancelled');
    await booking(9, 'declined');
    await booking(9, 'booked');
    const res = reservationsReportResponseSchema.parse(
      (await get(s.owner, `/reports/reservations${period}`).expect(200)).body,
    );
    expect(res).toEqual({
      covers: 13,
      walkInCovers: 5,
      kept: 3,
      noShows: 1,
      noShowRate: '25.0',
      turnMinutes: 90,
      turnTimes: [
        { min: 1, max: 2, bookings: 2, minutes: 75 },
        { min: 3, max: 4, bookings: 0, minutes: null },
        { min: 5, max: 6, bookings: 1, minutes: 120 },
        { min: 7, max: null, bookings: 0, minutes: null },
      ],
    });
  });

  const PATHS = [
    '/reports/sales/summary',
    '/reports/sales/hours',
    '/reports/sales/items',
    '/reports/sales/categories',
    '/reports/tables',
    '/reports/reservations',
  ];

  it('limits a manager to their locations and refuses everyone else', async () => {
    const s = await setup();
    await order(s.org, s.here, '2026-11-24T10:00:00Z', [[s.soup, 1, '1.00']]);
    await order(s.org, s.there, '2026-11-24T10:00:00Z', [[s.soup, 1, '2.00']]);
    const limited = await member(s.org, 'manager', [s.there]);
    expect((await summary(limited)).period.gross).toBe('2.00');
    expect((await summary(await member(s.org, 'manager'))).period.gross).toBe('3.00');
    for (const path of PATHS) {
      expect(codeOf(await get(limited, `${path}${period}&locationId=${s.here}`).expect(404))).toBe(
        'reports.location_not_found',
      );
      await get(limited, `${path}${period}&locationId=${uuidv7()}`).expect(404);
    }
    for (const role of ['staff', 'waiter', 'cashier', 'host', 'kitchen', 'bar'] as const) {
      const token = await member(s.org, role);
      for (const path of PATHS) await get(token, `${path}${period}`).expect(403);
    }
  });

  it('shows another organization nothing', async () => {
    const s = await setup();
    const other = await setup();
    await order(s.org, s.here, '2026-11-24T10:00:00Z', [[s.soup, 1, '1.00']]);
    expect((await summary(other.owner)).period.gross).toBe('0.00');
    const items = salesItemsResponseSchema.parse(
      (await get(other.owner, `/reports/sales/items${period}`).expect(200)).body,
    );
    expect(items.data).toEqual([]);
    await get(other.owner, `/reports/sales/summary${period}&locationId=${s.here}`).expect(404);
  });

  it('needs reports, and the till or reservations for its parts', async () => {
    const s = await setup();
    const off = (feature: string) =>
      entitlements.setOverride(s.org.id, feature, false, undefined, 'cli.entitlements');
    await off('reservations');
    await get(s.owner, `/reports/reservations${period}`).expect(403);
    await get(s.owner, `/reports/tables${period}`).expect(200);
    await off('reports');
    for (const path of PATHS) {
      expect(codeOf(await get(s.owner, `${path}${period}`).expect(403))).toBe(
        'entitlements.feature_disabled',
      );
    }
  });

  it('refuses bad periods', async () => {
    const s = await setup();
    for (const query of [
      '',
      '?from=2026-11-24',
      '?from=2026-11-25&to=2026-11-24',
      '?from=2026-02-30&to=2026-03-01',
      '?from=2025-01-01&to=2026-11-24',
      `${period}&locationId=x`,
    ]) {
      await get(s.owner, `/reports/sales/summary${query}`).expect(400);
    }
  });
});
