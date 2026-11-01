import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  reservationAvailabilityResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AvailabilityLoader } from '../src/modules/reservations/availability/loader';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { PrismaService } from '../src/platform/database';
import { TENANT_PRISMA, TenantContext } from '../src/platform/tenancy';
import { createTenantPrismaClient } from '../src/platform/tenancy/prisma-clients';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → Availability engine: GET /reservations/availability and its loader
 * (one fixed batch of queries per location and day).
 */
describe('GET /reservations/availability', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  /** Every Prisma operation the api runs, counted below the tenant client (also inside transactions). */
  const operations: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TENANT_PRISMA)
      .useFactory({
        inject: [PrismaService, TenantContext],
        factory: (prisma: PrismaService, context: TenantContext) =>
          createTenantPrismaClient(
            prisma.$extends({
              query: {
                $allOperations({ model, operation, args, query }) {
                  operations.push(`${model ?? 'raw'}.${operation}`);
                  return query(args);
                },
              },
            }) as unknown as PrismaService,
            context,
          ),
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  const SAT = '2027-03-06'; // a Saturday in the future: `now` never cuts slots off

  const get = (token: string, query: string) =>
    request(server)
      .get(`/api/v1/reservations/availability?${query}`)
      .auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: unknown) =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
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
    guest: string;
  }

  /** On `full`: a 2-, 4- and 6-top at the first location; the 6-top takes 4 guests or more. */
  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    const table = async (name: string, seats: number, sortOrder: number) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId: here, name, seats, sortOrder }).expect(201))
          .body,
      ).id;
    const t2 = await table('T2', 2, 1);
    const t4 = await table('T4', 4, 2);
    const t6 = await table('T6', 6, 3);
    const guest = await seed.as(org.id, async (db) => {
      await db.reservationTableRule.create({
        data: { tenantId: org.id, tableId: t6, locationId: here, minParty: 4 },
      });
      return (await db.reservationGuest.create({ data: { tenantId: org.id, locale: 'en' } })).id;
    });
    return { org, owner, here, there, t2, t4, t6, guest };
  }

  /** A booked reservation on `tableIds` (local Berlin times on SAT). */
  async function book(r: Restaurant, tableIds: string[], from: string, to: string, partySize = 2) {
    const start = new Date(`${SAT}T${from}:00+01:00`);
    const end = new Date(`${SAT}T${to}:00+01:00`);
    await seed.as(r.org.id, (db) =>
      db.$transaction(async (tx) => {
        const reservation = await tx.reservation.create({
          data: {
            tenantId: r.org.id,
            locationId: r.here,
            number: `RES-T-${uuidv7().slice(-10)}`,
            guestId: r.guest,
            partySize,
            startsAt: start,
            endsAt: end,
            status: 'booked',
            source: 'staff',
          },
        });
        for (const tableId of tableIds) {
          await tx.$executeRaw`
            INSERT INTO reservation_tables (tenant_id, reservation_id, location_id, table_id, period, blocking)
            VALUES (${r.org.id}::uuid, ${reservation.id}::uuid, ${r.here}::uuid, ${tableId}::uuid,
                    tstzrange(${start}, ${end}, '[)'), true)`;
        }
      }),
    );
  }

  const hhmm = (iso: string, timeZone = 'Europe/Berlin') =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));

  const query = (r: Restaurant, partySize: number, date = SAT) =>
    `locationId=${r.here}&date=${date}&partySize=${partySize}`;

  async function slots(r: Restaurant, partySize: number, token = r.owner) {
    return reservationAvailabilityResponseSchema.parse(
      (await get(token, query(r, partySize)).expect(200)).body,
    );
  }

  it('lists the slots of the day with the smallest fitting table', async () => {
    const r = await restaurant();
    const day = await slots(r, 2);
    expect(day).toMatchObject({ date: SAT, turnMinutes: 90, closed: false });
    const times = day.slots.map((s) => hhmm(s.start));
    expect(times[0]).toBe('11:00'); // default opening hours 11:00–23:00
    expect(times.at(-1)).toBe('22:00'); // 60 min before closing
    expect(day.slots[0]).toMatchObject({
      status: 'available',
      allocation: { kind: 'table', tableId: r.t2 },
    });
  });

  it('applies bookings and the 6-top rule: 2 guests never get it, 4 do', async () => {
    const r = await restaurant();
    await book(r, [r.t2], '19:00', '20:30');
    await book(r, [r.t4], '19:00', '21:00', 4);
    const two = await slots(r, 2);
    const at = (s: typeof two, time: string) => s.slots.find((x) => hhmm(x.start) === time);
    expect(at(two, '17:30')).toMatchObject({ allocation: { tableId: r.t2 } }); // ends 19:00
    expect(at(two, '17:45')).toMatchObject({ status: 'full', reason: 'no_table' });
    expect(at(two, '19:30')).toMatchObject({ status: 'full', reason: 'no_table' });
    const four = await slots(r, 4);
    expect(at(four, '19:30')).toMatchObject({ status: 'available', allocation: { tableId: r.t6 } });
  });

  it('uses a combination when no single table fits', async () => {
    const r = await restaurant();
    await seed.as(r.org.id, async (db) => {
      const combination = await db.reservationCombination.create({
        data: { tenantId: r.org.id, locationId: r.here, name: 'T4+T6', minParty: 7, maxParty: 10 },
      });
      await db.reservationCombinationTable.createMany({
        data: [r.t4, r.t6].map((tableId) => ({
          tenantId: r.org.id,
          combinationId: combination.id,
          locationId: r.here,
          tableId,
        })),
      });
    });
    const day = await slots(r, 8);
    expect(day.slots[0]?.allocation).toMatchObject({ kind: 'combination', tableIds: [r.t4, r.t6] });
  });

  it("reads the location's settings: time zone and closed days", async () => {
    const r = await restaurant();
    await request(server)
      .put(`/api/v1/settings/timezone?locationId=${r.here}`)
      .set('Idempotency-Key', uuidv7())
      .auth(r.owner, { type: 'bearer' })
      .send({ value: 'Europe/London' })
      .expect(200);
    const london = await slots(r, 2);
    expect(london.slots[0]?.start).toBe(`${SAT}T11:00:00.000Z`); // 11:00 GMT
    await request(server)
      .put(`/api/v1/settings/closedDates?locationId=${r.here}`)
      .set('Idempotency-Key', uuidv7())
      .auth(r.owner, { type: 'bearer' })
      .send({ value: [SAT] })
      .expect(200);
    expect(await slots(r, 2)).toMatchObject({ closed: true, slots: [] });
  });

  it('loads a location and day in one fixed batch of queries, however many bookings there are', async () => {
    const r = await restaurant();
    const loader = app.get(AvailabilityLoader);
    const count = async () => {
      operations.length = 0;
      await app
        .get(TenantContext)
        .run({ tenantId: r.org.id, userId: uuidv7() }, () =>
          loader.load({
            locationId: r.here,
            date: SAT,
            partySize: 2,
            channel: 'staff',
            now: new Date(),
          }),
        );
      return [...operations];
    };
    const empty = await count();
    for (const [from, to] of [
      ['12:00', '13:30'],
      ['14:00', '15:30'],
      ['17:00', '18:30'],
      ['19:00', '20:30'],
      ['21:00', '22:30'],
    ]) {
      await book(r, [r.t2], from!, to!);
    }
    const busy = await count();
    expect(busy).toEqual(empty);
    // Settings: the location (one transaction), then the stored values (another). Then tables, table
    // rules, combinations, bookings and open orders, each in its own. Every transaction first sets
    // app.tenant_id (raw.$executeRaw).
    expect(empty.filter((op) => !op.startsWith('raw.')).sort()).toEqual(
      [
        'Location.findUnique',
        'Organization.findUnique',
        'PartnerSettingValue.findMany',
        'SettingValue.findMany',
        'DiningTable.findMany',
        'ReservationTableRule.findMany',
        'ReservationCombination.findMany',
        'Reservation.findMany',
        'PosOrder.findMany',
      ].sort(),
    );
    expect(empty.filter((op) => op === 'raw.$executeRaw')).toHaveLength(7);
    expect(empty).toHaveLength(16);
  });

  describe('access and validation', () => {
    it('is for holders of reservations.bookings.read at the location', async () => {
      const r = await restaurant();
      for (const role of ['waiter', 'host', 'manager', 'admin'] as const) {
        await get(await memberToken(r.org, role), query(r, 2)).expect(200);
      }
      for (const role of ['staff', 'cashier'] as const) {
        const res = await get(await memberToken(r.org, role), query(r, 2)).expect(403);
        expect(res.body).toMatchObject({
          code: 'rbac.permission_denied',
          details: { permission: 'reservations.bookings.read' },
        });
      }
      const limited = await memberToken(r.org, 'host', [r.there]);
      const res = await get(limited, query(r, 2)).expect(404);
      expect(res.body).toMatchObject({ code: 'reservations.location_not_found' });
    });

    it('answers 404 for unknown and foreign locations', async () => {
      const a = await restaurant();
      const b = await restaurant();
      await get(a.owner, `locationId=${uuidv7()}&date=${SAT}&partySize=2`).expect(404);
      const foreign = await get(b.owner, query(a, 2)).expect(404);
      expect(foreign.body).toMatchObject({ code: 'reservations.location_not_found' });
    });

    it('validates date and party size', async () => {
      const r = await restaurant();
      for (const q of [
        `locationId=${r.here}&date=2027-02-30&partySize=2`,
        `locationId=${r.here}&date=6.3.2027&partySize=2`,
        `locationId=${r.here}&date=${SAT}&partySize=0`,
        `locationId=${r.here}&date=${SAT}&partySize=101`,
        `locationId=${r.here}&date=${SAT}&partySize=2.5`,
        `locationId=${r.here}&date=${SAT}`,
        `date=${SAT}&partySize=2`,
      ]) {
        const res = await get(r.owner, q).expect(400);
        expect(res.body).toMatchObject({ code: 'validation.failed' });
      }
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
      const res = await get(r.owner, query(r, 2)).expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });
});
