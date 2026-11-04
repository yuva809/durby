import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { diningTableSchema, reservationSchema, type SystemRole } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → GDPR, erasure on request (R1.9): a manager anonymises a guest; the
 * bookings stay, the personal data goes, and it never comes back.
 */
describe('reservations: guest anonymise', () => {
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

  const at = (time: string) => `2027-03-06T${time}:00+01:00`;

  const send = (token: string, method: 'post' | 'patch', path: string, body: unknown = {}) =>
    request(server)
      [method](`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);
  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const anonymise = (token: string, guestId: string) =>
    send(token, 'post', `/reservations/guests/${guestId}/anonymise`);

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  /** On `full`, one table at each of the two locations. */
  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    for (const [locationId, name] of [
      [here, 'T4'],
      [there, 'T9'],
    ] as const) {
      diningTableSchema.parse(
        (await send(owner, 'post', '/pos/tables', { locationId, name, seats: 4 }).expect(201)).body,
      );
    }
    return { org, owner, here, there };
  }

  const book = async (token: string, locationId: string, startsAt: string, extra: object = {}) =>
    reservationSchema.parse(
      (
        await send(token, 'post', '/reservations', {
          locationId,
          startsAt,
          partySize: 2,
          guest: { name: 'Ada Lovelace', phone: '030 1234567', email: 'ada@example.test' },
          guestNote: 'Allergic to nuts',
          staffNote: 'Regular, ask for Ada',
          ...extra,
        }).expect(201)
      ).body,
    );

  it('clears name, phone, email and notes, keeps the bookings, and audits without personal data', async () => {
    const r = await restaurant();
    const first = await book(r.owner, r.here, at('12:00'));
    const second = await book(r.owner, r.here, at('19:00'));
    expect(second.guest.id).toBe(first.guest.id);
    expect(first.guest.anonymisedAt).toBeNull();

    const res = await anonymise(r.owner, first.guest.id).expect(201);
    expect(res.body).toEqual({ id: first.guest.id, anonymisedAt: expect.any(String) as unknown });

    for (const b of [first, second]) {
      const after = reservationSchema.parse((await get(r.owner, `/reservations/${b.id}`)).body);
      expect(after).toMatchObject({
        id: b.id,
        number: b.number,
        status: 'booked',
        partySize: 2,
        tableIds: b.tableIds,
        guestNote: null,
        staffNote: null,
        guest: {
          id: first.guest.id,
          name: null,
          email: null,
          phone: null,
          anonymisedAt: (res.body as { anonymisedAt: string }).anonymisedAt,
        },
      });
    }
    const audit = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { action: 'reservations.guest.anonymised' },
        select: { entityType: true, entityId: true, before: true, after: true },
      }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: 'reservation_guest', entityId: first.guest.id });
    const text = JSON.stringify(audit);
    for (const personal of ['Ada', 'ada@example.test', '+49301234567', 'nuts', 'Regular']) {
      expect(text).not.toContain(personal);
    }
  });

  it('answers the same again without a second audit row', async () => {
    const r = await restaurant();
    const b = await book(r.owner, r.here, at('12:00'));
    const first = (await anonymise(r.owner, b.guest.id).expect(201)).body as object;
    const again = (await anonymise(r.owner, b.guest.id).expect(201)).body as object;
    expect(again).toEqual(first);
    const count = await seed.as(r.org.id, (db) =>
      db.auditLog.count({ where: { action: 'reservations.guest.anonymised' } }),
    );
    expect(count).toBe(1);
  });

  it('never matches or refills an anonymised guest', async () => {
    const r = await restaurant();
    const old = await book(r.owner, r.here, at('12:00'));
    await anonymise(r.owner, old.guest.id).expect(201);

    // Same email and phone: a new guest, not the erased one.
    const later = await book(r.owner, r.here, at('19:00'));
    expect(later.guest.id).not.toBe(old.guest.id);
    expect(later.guest).toMatchObject({ name: 'Ada Lovelace', anonymisedAt: null });

    // Staff add details to the erased guest's booking: it moves to a live guest; the erased
    // one stays empty.
    const edited = reservationSchema.parse(
      (
        await send(r.owner, 'patch', `/reservations/${old.id}`, {
          guest: { name: 'Grace' },
        }).expect(200)
      ).body,
    );
    expect(edited.guest.id).not.toBe(old.guest.id);
    expect(edited.guest).toMatchObject({ name: 'Grace', anonymisedAt: null });
    const erased = await seed.as(r.org.id, (db) =>
      db.reservationGuest.findUniqueOrThrow({ where: { id: old.guest.id } }),
    );
    expect(erased).toMatchObject({ name: null, email: null, phone: null });
  });

  it('needs reservations.setup.manage at every location the guest has bookings at', async () => {
    const r = await restaurant();
    const here = await book(r.owner, r.here, at('12:00'));
    await book(r.owner, r.there, at('12:00'));

    const host = await memberToken(r.org, 'host');
    const res = await anonymise(host, here.guest.id).expect(403);
    expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });

    // A manager of one branch can't erase a guest the other branch has too.
    const branchManager = await memberToken(r.org, 'manager', [r.here]);
    await anonymise(branchManager, here.guest.id).expect(403);

    // A guest only the other branch knows is not visible to them at all.
    const onlyThere = await book(r.owner, r.there, at('19:00'), {
      guest: { name: 'Bob', email: 'bob@example.test' },
    });
    const hidden = await anonymise(branchManager, onlyThere.guest.id).expect(404);
    expect(hidden.body).toMatchObject({ code: 'reservations.guest_not_found' });

    const manager = await memberToken(r.org, 'manager');
    await anonymise(manager, here.guest.id).expect(201);
  });

  it("never reaches another organization's guest", async () => {
    const [a, b] = await Promise.all([restaurant(), restaurant()]);
    const theirs = await book(b.owner, b.here, at('12:00'));
    const res = await anonymise(a.owner, theirs.guest.id).expect(404);
    expect(res.body).toMatchObject({ code: 'reservations.guest_not_found' });
    await anonymise(a.owner, uuidv7()).expect(404);
    const still = await seed.as(b.org.id, (db) =>
      db.reservationGuest.findUniqueOrThrow({ where: { id: theirs.guest.id } }),
    );
    expect(still).toMatchObject({ name: 'Ada Lovelace', anonymisedAt: null });
  });
});
