import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SystemRole } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { GuestRetention } from '../src/modules/reservations/bookings/guest-retention';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { OutboxCleanup } from '../src/platform/outbox';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → GDPR, Retention (Q8, R2.5): guests' personal data is erased automatically once the
 * retention period after their last visit or booking has passed. Bookings and counts stay.
 */
describe('reservations: automatic guest data retention', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let retention: GuestRetention;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    retention = app.get(GuestRetention);
  });

  afterAll(async () => {
    await app.close();
  });

  const NOW = new Date('2027-06-15T10:00:00Z');
  const monthsAgo = (n: number) => {
    const d = new Date(NOW);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d;
  };

  async function restaurant() {
    const org = await seed.org('Bistro');
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles['owner' as SystemRole]);
    return { org, owner: await seed.token(userId, org.id) };
  }

  /** A guest with one booking at `start` (2 hours), written straight to the database: the api refuses past times. */
  async function guest(
    org: SeededOrg,
    name: string,
    opts: { created: Date; start?: Date; status?: string; lastVisit?: Date },
  ) {
    return seed.as(org.id, async (db) => {
      const g = await db.reservationGuest.create({
        data: {
          tenantId: org.id,
          name,
          email: `${name.toLowerCase()}@example.test`,
          phone: '+49301234567',
          locale: 'en',
          createdAt: opts.created,
          lastVisitAt: opts.lastVisit ?? null,
        },
      });
      if (opts.start) {
        await db.reservation.create({
          data: {
            tenantId: org.id,
            locationId: org.locations[0],
            number: `R-${uuidv7().slice(-10)}`,
            guestId: g.id,
            partySize: 2,
            startsAt: opts.start,
            endsAt: new Date(opts.start.getTime() + 2 * 3_600_000),
            status: (opts.status ?? 'finished') as 'finished',
            source: 'staff',
            guestNote: 'Allergic to nuts',
            staffNote: 'Regular',
            manageTokenHash: uuidv7(),
          },
        });
      }
      await db.guestMarketingConsent.create({
        data: { tenantId: org.id, guestId: g.id, granted: true, source: 'online_booking' },
      });
      return g.id;
    });
  }

  const run = (org: SeededOrg, now = NOW) =>
    seed.as(org.id, (db) => db.$transaction((tx) => retention.run(tx, now)));
  const guestRow = (org: SeededOrg, id: string) =>
    seed.as(org.id, (db) => db.reservationGuest.findUniqueOrThrow({ where: { id } }));

  it('erases guests past the period, keeps their bookings and consents, and audits as the system', async () => {
    const { org } = await restaurant();
    const old = await guest(org, 'Ada', { created: monthsAgo(20), start: monthsAgo(13) });
    const recent = await guest(org, 'Grace', { created: monthsAgo(20), start: monthsAgo(11) });
    expect(await run(org)).toBe(1);

    expect(await guestRow(org, old)).toMatchObject({
      name: null,
      email: null,
      phone: null,
      anonymisedAt: NOW,
    });
    const booking = await seed.as(org.id, (db) =>
      db.reservation.findFirstOrThrow({ where: { guestId: old } }),
    );
    expect(booking).toMatchObject({
      status: 'finished',
      partySize: 2,
      guestNote: null,
      staffNote: null,
      manageTokenHash: null,
    });
    expect(
      await seed.as(org.id, (db) => db.guestMarketingConsent.count({ where: { guestId: old } })),
    ).toBe(1);
    expect(await guestRow(org, recent)).toMatchObject({ name: 'Grace', anonymisedAt: null });

    const audit = await seed.as(org.id, (db) =>
      db.auditLog.findMany({
        where: { action: 'reservations.guest.anonymised' },
        select: { entityId: true, actorType: true, actorSystem: true, before: true, after: true },
      }),
    );
    expect(audit).toMatchObject([
      { entityId: old, actorType: 'system', actorSystem: 'job.guest_retention' },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/Ada|example\.test|nuts|Regular|\+4930/);

    // Nothing left to do: a second pass changes nothing.
    expect(await run(org)).toBe(0);
  });

  it('counts from the latest of the last visit, the last booking and the guest itself', async () => {
    const { org } = await restaurant();
    // Booked long ago, but visited (e.g. a walk-in seated at the till) 2 months ago.
    const visited = await guest(org, 'Visit', {
      created: monthsAgo(30),
      start: monthsAgo(25),
      lastVisit: monthsAgo(2),
    });
    // Never booked, created 13 months ago.
    const neverBooked = await guest(org, 'Never', { created: monthsAgo(13) });
    // A cancelled booking long ago still counts as the last contact.
    const cancelled = await guest(org, 'Cancel', {
      created: monthsAgo(30),
      start: monthsAgo(14),
      status: 'cancelled',
    });
    expect(await run(org)).toBe(2);
    expect((await guestRow(org, visited)).anonymisedAt).toBeNull();
    expect((await guestRow(org, neverBooked)).anonymisedAt).toEqual(NOW);
    expect((await guestRow(org, cancelled)).anonymisedAt).toEqual(NOW);
  });

  it('never erases a guest with a booking still to come', async () => {
    const { org } = await restaurant();
    const id = await guest(org, 'Soon', { created: monthsAgo(30), start: monthsAgo(20) });
    await seed.as(org.id, (db) =>
      db.reservation.create({
        data: {
          tenantId: org.id,
          locationId: org.locations[0],
          number: `R-${uuidv7().slice(-10)}`,
          guestId: id,
          partySize: 2,
          startsAt: new Date(NOW.getTime() + 7 * 86_400_000),
          endsAt: new Date(NOW.getTime() + 7 * 86_400_000 + 7_200_000),
          status: 'requested',
          source: 'online',
        },
      }),
    );
    expect(await run(org)).toBe(0);
    expect((await guestRow(org, id)).name).toBe('Soon');
  });

  it('follows the organization’s retention period, and leaves other organizations alone', async () => {
    const a = await restaurant();
    const b = await restaurant();
    const inA = await guest(a.org, 'Ada', { created: monthsAgo(20), start: monthsAgo(13) });
    const inB = await guest(b.org, 'Bea', { created: monthsAgo(20), start: monthsAgo(13) });
    await request(server)
      .put('/api/v1/settings/reservations.guestRetentionMonths')
      .set('Idempotency-Key', uuidv7())
      .auth(a.owner, { type: 'bearer' })
      .send({ value: 24 })
      .expect(200);
    expect(await run(a.org)).toBe(0);
    expect((await guestRow(a.org, inA)).name).toBe('Ada');
    expect((await guestRow(b.org, inB)).name).toBe('Bea');
    // A location can't keep data longer than its organization decided.
    await request(server)
      .put(`/api/v1/settings/reservations.guestRetentionMonths?locationId=${a.org.locations[0]}`)
      .set('Idempotency-Key', uuidv7())
      .auth(a.owner, { type: 'bearer' })
      .send({ value: 60 })
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
  });

  it('is part of the worker’s hourly pass', () => {
    const register = vi.spyOn(app.get(OutboxCleanup), 'register').mockReturnValue();
    retention.onModuleInit();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'guestRetention' }));
    register.mockRestore();
  });
});
