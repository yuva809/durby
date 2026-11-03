import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  productCategorySchema,
  productSchema,
  reservationSchema,
  reservationsFloorResponseSchema,
  type ReservationsFloorTable,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Clock } from '../src/platform/auth';
import { AccessTokenService } from '../src/platform/auth/access-token.service';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { FakeClock } from './support/fake-clock';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → Derived floor state: the host floor at a moment, for roles without
 * pos order keys (Host). Occupancy comes from pos's read port, without order data. The api's clock
 * is a FakeClock on a Saturday evening (Europe/Berlin, the default timezone); tokens are signed at
 * that time.
 */
describe('GET /reservations/floor', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let tokens: AccessTokenService;
  const clock = new FakeClock();

  const SAT = '2027-03-06';
  const SUN = '2027-03-07';
  const at = (time: string, date = SAT) => `${date}T${time}:00+01:00`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    tokens = app.get(AccessTokenService);
  });

  beforeEach(() => clock.set(new Date(at('19:00'))));

  afterAll(async () => {
    await app.close();
  });

  /** A member; requests sign a token at the fake clock's time. */
  interface Member {
    userId: string;
    orgId: string;
  }
  const token = (m: Member) =>
    tokens.sign({ userId: m.userId, organizationId: m.orgId, sessionId: uuidv7() }, clock.now());
  const get = async (m: Member, path: string) =>
    request(server)
      .get(`/api/v1${path}`)
      .auth(await token(m), { type: 'bearer' });
  const send = async (m: Member, method: 'post' | 'put' | 'patch', path: string, body = {}) =>
    request(server)
      [method](`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(await token(m), { type: 'bearer' })
      .send(body);

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]): Promise<Member> {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return { userId, orgId: org.id };
  }

  /**
   * On `full`, at 19:00 (all parties of 2, turn 90 min):
   * T1 till order without a booking (2 covers) · T2 booked 19:30 · T3 booked 18:55, seated ·
   * T4 booked 19:10, arrived · T5 booked 18:45, late · T6 booked 21:00 · W7 walk-in only.
   * T9 at the second location.
   */
  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await member(org, 'owner');
    const [here, there] = org.locations;
    const table = async (locationId: string, name: string, sortOrder: number) =>
      diningTableSchema.parse(
        (await send(owner, 'post', '/pos/tables', { locationId, name, seats: 4, sortOrder })).body,
      ).id;
    const t: Record<string, string> = {};
    for (const [i, name] of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'W7'].entries()) {
      t[name] = await table(here, name, i + 1);
    }
    await table(there, 'T9', 1);
    await send(owner, 'put', `/reservations/tables/${t.W7}/rule`, {
      bookingMode: 'walk_in_only',
      minParty: 1,
      maxParty: null,
    }).then((res) => expect(res.status).toBe(200));

    const category = productCategorySchema.parse(
      (await send(owner, 'post', '/catalog/categories', { name: 'Food' })).body,
    );
    const soup = productSchema.parse(
      (
        await send(owner, 'post', '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        })
      ).body,
    );
    const ticket = await send(owner, 'post', `/pos/tables/${t.T1}/tickets`, {
      lines: [{ productId: soup.id, quantity: 1 }],
      covers: 2,
    });
    expect(ticket.status).toBe(201);

    const book = async (tableId: string, startsAt: string, name: string) => {
      const res = await send(owner, 'post', '/reservations', {
        locationId: here,
        startsAt,
        partySize: 2,
        tableIds: [tableId],
        guest: { name },
        force: true,
      });
      expect(res.status).toBe(201);
      return reservationSchema.parse(res.body);
    };
    const act = async (id: string, action: string) =>
      expect((await send(owner, 'post', `/reservations/${id}/${action}`)).status).toBe(201);

    const b = {
      t2: await book(t.T2!, at('19:30'), 'Weber'),
      t3: await book(t.T3!, at('18:55'), 'Klein'),
      t4: await book(t.T4!, at('19:10'), 'Braun'),
      t5: await book(t.T5!, at('18:45'), 'Ali'),
      t6: await book(t.T6!, at('21:00'), 'Schmidt'),
    };
    await act(b.t3.id, 'seat');
    await act(b.t4.id, 'arrive');
    return { org, owner, here, there, t, b };
  }

  const floorOf = async (m: Member, query: string) => {
    const res = await get(m, `/reservations/floor?${query}`);
    expect(res.status).toBe(200);
    return reservationsFloorResponseSchema.parse(res.body);
  };
  const byName = (tables: ReservationsFloorTable[]) =>
    Object.fromEntries(tables.map((x) => [x.name, x]));

  it('derives every state now, for a Host without pos order keys and without order data', async () => {
    const r = await restaurant();
    const host = await member(r.org, 'host');
    // The pos floor needs pos.orders.read, which Host doesn't hold: occupancy comes from here.
    const denied = await get(host, `/pos/floor?locationId=${r.here}`);
    expect(denied.status).toBe(403);

    const floor = await floorOf(host, `locationId=${r.here}`);
    expect(floor).toMatchObject({ at: new Date(at('19:00')).toISOString(), date: SAT, live: true });
    expect(floor.serviceWindows).toEqual([
      { start: new Date(at('11:00')).toISOString(), end: new Date(at('23:00')).toISOString() },
    ]);
    expect(floor.data.map((x) => [x.name, x.state, x.occupied, x.covers, x.walkInOnly])).toEqual([
      ['T1', 'occupied', true, 2, false],
      ['T2', 'reserved_soon', false, null, false],
      ['T3', 'occupied', true, 2, false],
      ['T4', 'arriving', false, null, false],
      ['T5', 'reserved', false, null, false],
      ['T6', 'free', false, null, false],
      ['W7', 'free', false, null, true],
    ]);
    const t = byName(floor.data);
    expect(t.T1!.current).toMatchObject({ reservationId: null, partySize: 2, guestName: null });
    expect(Date.parse(t.T1!.occupiedSince ?? '')).not.toBeNaN();
    expect(t.T2!.next).toEqual({
      reservationId: r.b.t2.id,
      startsAt: new Date(at('19:30')).toISOString(),
      partySize: 2,
      guestName: 'Weber',
      tableStillOccupied: false,
    });
    expect(t.T3!.current).toMatchObject({ reservationId: r.b.t3.id, guestName: 'Klein' });
    expect(t.T4!.current?.reservationId).toBe(r.b.t4.id);
    expect(t.T5!.current?.reservationId).toBe(r.b.t5.id);
    expect(t.T6!.next?.reservationId).toBe(r.b.t6.id);
    // Table, bookings and occupancy only: no order id, number, items or totals.
    expect(Object.keys(t.T1!).sort()).toEqual([
      'area',
      'areaId',
      'color',
      'covers',
      'current',
      'id',
      'locationId',
      'name',
      'next',
      'occupied',
      'occupiedSince',
      'overrun',
      'seats',
      'shape',
      'sortOrder',
      'state',
      'walkInOnly',
    ]);
  });

  it('keeps an overrunning party on its table and flags the booking due next', async () => {
    const r = await restaurant();
    // T3's party (18:55–20:25) is still seated at 21:05; a 20:30 booking was made for T3.
    const due = reservationSchema.parse(
      (
        await send(r.owner, 'post', '/reservations', {
          locationId: r.here,
          startsAt: at('20:30'),
          partySize: 2,
          tableIds: [r.t.T3],
          guest: { name: 'Late' },
          force: true,
        })
      ).body,
    );
    clock.set(new Date(at('21:05')));
    const t3 = byName((await floorOf(r.owner, `locationId=${r.here}`)).data).T3!;
    expect(t3).toMatchObject({ state: 'occupied', overrun: true });
    expect(t3.current?.reservationId).toBe(r.b.t3.id);
    expect(t3.next).toMatchObject({ reservationId: due.id, tableStillOccupied: true });
  });

  it('shows a later time today with the occupancy known now', async () => {
    const r = await restaurant();
    const floor = await floorOf(
      r.owner,
      `locationId=${r.here}&at=${encodeURIComponent(at('21:00'))}`,
    );
    expect(floor).toMatchObject({ date: SAT, live: true });
    const t = byName(floor.data);
    expect(t.T6!.state).toBe('reserved');
    // The till order's expected end (19:00 + 15 min rolling, turn 90 from its opening) is past.
    expect(t.T1!.state).toBe('free');
  });

  it('shows another day as a plan: bookings only, from the first service window', async () => {
    const r = await restaurant();
    await send(r.owner, 'post', '/reservations', {
      locationId: r.here,
      startsAt: at('11:30', SUN),
      partySize: 2,
      tableIds: [r.t.T2],
      guest: { name: 'Sunday' },
      force: true,
    }).then((res) => expect(res.status).toBe(201));
    const floor = await floorOf(r.owner, `locationId=${r.here}&date=${SUN}`);
    expect(floor).toMatchObject({
      at: new Date(at('11:00', SUN)).toISOString(),
      date: SUN,
      live: false,
    });
    const t = byName(floor.data);
    expect(t.T1!.state).toBe('free'); // the open till order is today's
    expect(t.T2!.state).toBe('reserved_soon');
    expect(t.T2!.next?.guestName).toBe('Sunday');
    expect(floor.data.every((x) => !x.overrun && !x.next?.tableStillOccupied)).toBe(true);

    // A time on that day: `at`, still bookings only.
    const later = await floorOf(
      r.owner,
      `locationId=${r.here}&at=${encodeURIComponent(at('12:00', SUN))}`,
    );
    expect(later.live).toBe(false);
    expect(byName(later.data).T2!.state).toBe('reserved');
    // Today's date means now.
    expect(await floorOf(r.owner, `locationId=${r.here}&date=${SAT}`)).toMatchObject({
      at: new Date(at('19:00')).toISOString(),
      live: true,
    });
  });

  it("follows the location's floor horizon", async () => {
    const r = await restaurant();
    const set = await send(
      r.owner,
      'put',
      `/reservations/settings/reservations.floorHorizonMinutes?locationId=${r.here}`,
      { value: 15 },
    );
    expect(set.status).toBe(200);
    // T2's 19:30 booking is 30 minutes away: not "soon" anymore.
    expect(byName((await floorOf(r.owner, `locationId=${r.here}`)).data).T2!.state).toBe('free');
  });

  it('frees the table when the order is closed', async () => {
    const r = await restaurant();
    const order = (await get(r.owner, `/pos/tables/${r.t.T1}/order`)).body as {
      order: { id: string };
    };
    expect((await send(r.owner, 'post', `/pos/orders/${order.order.id}/close`)).status).toBe(201);
    const t1 = byName((await floorOf(r.owner, `locationId=${r.here}`)).data).T1!;
    expect(t1).toMatchObject({ state: 'free', occupied: false, current: null });
  });

  it('is for holders of reservations.bookings.read at that location', async () => {
    const r = await restaurant();
    for (const role of ['waiter', 'manager', 'admin', 'owner'] as const) {
      const res = await get(await member(r.org, role), `/reservations/floor?locationId=${r.here}`);
      expect(res.status).toBe(200);
    }
    for (const role of ['staff', 'cashier'] as const) {
      const res = await get(await member(r.org, role), `/reservations/floor?locationId=${r.here}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'rbac.permission_denied',
        details: { permission: 'reservations.bookings.read' },
      });
    }
    // A host limited to the first location: the second doesn't exist for them.
    const limited = await member(r.org, 'host', [r.here]);
    expect((await get(limited, `/reservations/floor?locationId=${r.here}`)).status).toBe(200);
    const other = await get(limited, `/reservations/floor?locationId=${r.there}`);
    expect(other.status).toBe(404);
    expect(other.body).toMatchObject({ code: 'reservations.location_not_found' });
  });

  it('answers 404 for unknown locations, 400 for bad queries', async () => {
    const r = await restaurant();
    const host = await member(r.org, 'host');
    const unknown = await get(host, `/reservations/floor?locationId=${uuidv7()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'reservations.location_not_found' });
    for (const query of [
      'locationId=nope',
      '',
      `locationId=${r.here}&date=2027-3-7`,
      `locationId=${r.here}&at=tonight`,
      `locationId=${r.here}&date=${SUN}&at=${encodeURIComponent(at('12:00', SUN))}`,
    ]) {
      expect((await get(host, `/reservations/floor?${query}`)).status).toBe(400);
    }
  });

  it('needs the reservations feature', async () => {
    const r = await restaurant();
    const host = await member(r.org, 'host');
    await entitlements.setOverride(r.org.id, 'reservations', false, undefined, 'cli.entitlements');
    const res = await get(host, `/reservations/floor?locationId=${r.here}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
  });

  it("never shows another organization's floor or bookings", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const hostB = await member(b.org, 'host');
    const res = await get(hostB, `/reservations/floor?locationId=${a.here}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'reservations.location_not_found' });
    // B's own floor shows only B's bookings.
    const own = await floorOf(hostB, `locationId=${b.here}`);
    const ids = own.data.flatMap((x) => [x.current?.reservationId, x.next?.reservationId]);
    expect(ids).not.toContain(a.b.t2.id);
    expect(byName(own.data).T2!.next?.reservationId).toBe(b.b.t2.id);
  });
});
