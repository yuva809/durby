import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  notificationListResponseSchema,
  overviewResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DailyReport } from '../src/modules/reports';
import { ReportsService } from '../src/modules/reports/reports.service';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reports.md → Daily report (ADR 0083). Now: Tuesday 24 Nov 2026, 08:00 in Berlin; yesterday is Monday the
 * 23rd, its normal day the Mondays 16, 9 and 2 Nov and 26 Oct.
 */
const NOW = new Date('2026-11-24T07:00:00Z');

describe('daily sales report', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let report: DailyReport;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    report = app.get(DailyReport);
    // Only the reports' clock: sign-in keeps the real one.
    Object.assign(app.get(ReportsService), { clock: { now: () => NOW } });
  });

  afterAll(async () => {
    await app.close();
  });

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    const id = await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return { id, userId, token: await seed.token(userId, org.id) };
  }

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const [here, there] = org.locations;
    return { org, here, there, owner: await member(org, 'owner') };
  }

  async function sold(org: SeededOrg, locationId: string, at: string, gross: string) {
    const orderId = uuidv7();
    await seed.as(org.id, async (db) => {
      await db.reportOrderFact.create({
        data: {
          tenantId: org.id,
          locationId,
          orderId,
          tableId: uuidv7(),
          openedAt: new Date(at),
          rounds: 1,
          firstSentAt: new Date(at),
        },
      });
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
    });
  }

  const inbox = async (token: string) =>
    notificationListResponseSchema.parse(
      (
        await request(server)
          .get('/api/v1/notifications')
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body,
    );
  const send = (org: SeededOrg, now = NOW, force = false) => report.send(org.id, { now, force });
  const rows = (org: SeededOrg) => seed.as(org.id, (db) => db.reportDailyMessage.findMany());
  const events = (org: SeededOrg) =>
    seed.as(org.id, (db) =>
      db.outboxEvent.count({ where: { type: 'platform.notification.created' } }),
    );

  it('tells the owner yesterday’s sales, the same figures as the overview', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '50.00');
    await sold(s.org, s.here, '2026-11-24T00:30:00Z', '7.00'); // 01:30: still Monday
    await sold(s.org, s.there, '2026-11-23T12:00:00Z', '10.00');
    await sold(s.org, s.here, '2026-11-24T06:00:00Z', '99.00'); // 07:00 today
    await sold(s.org, s.here, '2026-11-16T12:00:00Z', '60.00');
    await sold(s.org, s.here, '2026-11-09T12:00:00Z', '40.00');
    expect(await send(s.org)).toBe('sent');

    const { data, unread } = await inbox(s.owner.token);
    expect(unread).toBe(1);
    expect(data[0]).toMatchObject({
      kind: 'daily_sales',
      entityType: 'daily_report',
      params: {
        day: '2026-11-23',
        currency: 'EUR',
        gross: '67.00',
        orders: '3',
        average: '22.33',
        percent: '14.0', // 57 against (60 + 40) / 2
        leftOut: '1',
        bestName: 'L1',
        bestGross: '57.00',
      },
    });
    const overview = overviewResponseSchema.parse(
      (
        await request(server)
          .get('/api/v1/reports/overview')
          .auth(s.owner.token, { type: 'bearer' })
          .expect(200)
      ).body,
    );
    expect(overview.total.yesterday).toMatchObject({
      gross: '67.00',
      orders: 3,
      normal: { changePercent: '14.0' },
      leftOut: 1,
    });
    // Push is on by default, so the worker gets it to deliver.
    expect(await events(s.org)).toBe(1);
  });

  it('leaves out what there is not: no comparison, a single location', async () => {
    const s = await setup();
    await seed.as(s.org.id, (db) =>
      db.location.update({ where: { id: s.there }, data: { archivedAt: new Date() } }),
    );
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    await sold(s.org, s.there, '2026-11-23T12:00:00Z', '500.00'); // archived: not shown
    expect(await send(s.org)).toBe('sent');
    expect((await inbox(s.owner.token)).data[0]!.params).toEqual({
      day: '2026-11-23',
      currency: 'EUR',
      gross: '20.00',
      orders: '1',
      average: '20.00',
    });
  });

  it('goes to active owners only', async () => {
    const s = await setup();
    const second = await member(s.org, 'owner');
    const gone = await member(s.org, 'owner');
    await seed.as(s.org.id, (db) =>
      db.membership.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } }),
    );
    const others = [
      await member(s.org, 'admin'),
      await member(s.org, 'manager'),
      await member(s.org, 'manager', [s.here]),
      await member(s.org, 'waiter'),
    ];
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    expect(await send(s.org)).toBe('sent');
    const told = await seed.as(s.org.id, (db) =>
      db.notification.findMany({ select: { userId: true } }),
    );
    expect(told.map((n) => n.userId).sort()).toEqual([s.owner.userId, second.userId].sort());
    for (const other of others) expect((await inbox(other.token)).data).toEqual([]);
  });

  it('is sent once, also when two workers do it at the same time', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    const results = await Promise.all([send(s.org), send(s.org), send(s.org)]);
    expect(results.sort()).toEqual(['done', 'done', 'sent']);
    expect(await send(s.org)).toBe('done');
    expect(await send(s.org, NOW, true)).toBe('done');
    expect((await inbox(s.owner.token)).data).toHaveLength(1);
    expect(await rows(s.org)).toHaveLength(1);
    // The next day is a new one.
    await sold(s.org, s.here, '2026-11-24T12:00:00Z', '30.00');
    expect(await send(s.org, new Date('2026-11-25T07:00:00Z'))).toBe('sent');
    expect((await inbox(s.owner.token)).data.map((n) => n.params.day)).toEqual([
      '2026-11-24',
      '2026-11-23',
    ]);
  });

  it('waits for its time, can be sent by hand, and is skipped when too late', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    expect(await send(s.org, new Date('2026-11-24T06:59:00Z'))).toBe('early');
    expect(await send(s.org, new Date('2026-11-24T19:00:00Z'))).toBe('late');
    // Before 04:00 the day has not ended: not by hand either.
    expect(await send(s.org, new Date('2026-11-24T02:59:00Z'), true)).toBe('early');
    expect(await rows(s.org)).toEqual([]);
    expect(await send(s.org, new Date('2026-11-24T03:00:00Z'), true)).toBe('sent');
  });

  it('follows the time set', async () => {
    const s = await setup();
    await withIdempotencyKey(
      request(server)
        .put('/api/v1/settings/reports.dailyReportAt')
        .auth(s.owner.token, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ value: '10:00' })
      .expect(200);
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    expect(await send(s.org)).toBe('early');
    expect(await send(s.org, new Date('2026-11-24T09:00:00Z'))).toBe('sent');
  });

  it('sends nothing for a day without orders', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-16T12:00:00Z', '20.00');
    expect(await send(s.org)).toBe('no_orders');
    expect(await send(s.org)).toBe('no_orders');
    expect((await inbox(s.owner.token)).data).toEqual([]);
    expect(await events(s.org)).toBe(0);
    // Report data that comes later the same morning (a rebuild) is still reported, once.
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    expect(await send(s.org)).toBe('sent');
    expect(await send(s.org)).toBe('done');
  });

  it('needs reports and the till', async () => {
    for (const feature of ['reports', 'pos']) {
      const s = await setup();
      await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
      await entitlements.setOverride(s.org.id, feature, false, undefined, 'cli.entitlements');
      expect(await send(s.org)).toBe('off');
      expect(await rows(s.org)).toEqual([]);
    }
    expect(await report.send(uuidv7(), { now: NOW })).toBe('off');
  });

  it('keeps a message under the bell for an owner who turned push off', async () => {
    const s = await setup();
    await withIdempotencyKey(
      request(server)
        .put('/api/v1/notifications/preferences')
        .auth(s.owner.token, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ preferences: [{ kind: 'daily_sales', email: false, push: false }] })
      .expect(200);
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    expect(await send(s.org)).toBe('sent');
    expect((await inbox(s.owner.token)).data).toHaveLength(1);
    expect(await events(s.org)).toBe(0);
  });

  it('keeps organizations apart', async () => {
    const s = await setup();
    const other = await setup();
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    expect(await send(s.org)).toBe('sent');
    expect(await send(other.org)).toBe('no_orders');
    expect((await inbox(other.owner.token)).data).toEqual([]);
    const [mine] = await rows(s.org);
    const seen = await seed.as(other.org.id, (db) =>
      db.reportDailyMessage.findMany({ where: { id: mine!.id } }),
    );
    expect(seen).toEqual([]);
    // Writing a row for another organization is refused by the policy.
    await expect(
      seed.as(other.org.id, (db) =>
        db.reportDailyMessage.create({ data: { tenantId: s.org.id, day: new Date('2026-01-01') } }),
      ),
    ).rejects.toThrow();
  });

  it('goes on after an organization that fails, and tries that one again', async () => {
    const bad = await setup();
    const good = await setup();
    for (const s of [bad, good]) await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    // Only these two: the test database is shared with the other suites.
    const { platform } = report as unknown as {
      platform: { organization: { findMany: () => Promise<{ id: string }[]> } };
    };
    const orgs = vi
      .spyOn(platform.organization, 'findMany')
      .mockImplementation(() => Promise.resolve([{ id: bad.org.id }, { id: good.org.id }]));
    const original = report.send.bind(report);
    const spy = vi
      .spyOn(report, 'send')
      .mockImplementation((id, options) =>
        id === bad.org.id ? Promise.reject(new Error('broken')) : original(id, options),
      );
    const counts = await report.sendDue(NOW);
    spy.mockRestore();
    expect(counts).toEqual({ sent: 1, failed: 1 });
    expect((await inbox(good.owner.token)).data).toHaveLength(1);
    expect((await inbox(bad.owner.token)).data).toEqual([]);
    expect(await report.sendDue(NOW)).toEqual({ sent: 1, failed: 0 });
    orgs.mockRestore();
    expect((await inbox(bad.owner.token)).data).toHaveLength(1);
    expect((await inbox(good.owner.token)).data).toHaveLength(1);
  });

  it('a failed notification leaves no row behind', async () => {
    const s = await setup();
    await sold(s.org, s.here, '2026-11-23T12:00:00Z', '20.00');
    const notifications = (
      report as unknown as { notifications: { notify: (...args: unknown[]) => Promise<string[]> } }
    ).notifications;
    const spy = vi.spyOn(notifications, 'notify').mockRejectedValue(new Error('no'));
    await expect(send(s.org)).rejects.toThrow('no');
    spy.mockRestore();
    expect(await rows(s.org)).toEqual([]);
    expect(await send(s.org)).toBe('sent');
  });
});
