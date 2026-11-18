import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  type EventType,
  productCategorySchema,
  productSchema,
  realtimeChangedSchema,
  realtimeReadySchema,
  reservationSchema,
  sendTicketResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AccessTokenService } from '../src/platform/auth/access-token.service';
import { RevocationService } from '../src/platform/auth';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { PrismaService } from '../src/platform/database';
import { OutboxEventRunner } from '../src/platform/outbox';
import { RealtimeHub } from '../src/platform/realtime';
import { emptyPlanFor } from './support/plans';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { isEvent, isPing, openSse, type SseClient, within } from './support/sse';

/**
 * docs/platform/realtime.md, ADR 0044 (RT.1): the reservations and pos streams. Events are delivered
 * with the outbox's own runner, as the worker would; the stream gets them through Redis.
 */
const HEARTBEAT_MS = 300;

async function startApp(): Promise<{ app: INestApplication; base: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}/api/v1` };
}

describe('realtime streams', () => {
  let app: INestApplication;
  let base: string;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  const previousHeartbeat = process.env.REALTIME_HEARTBEAT_MS;
  const open: SseClient[] = [];

  beforeAll(async () => {
    process.env.REALTIME_HEARTBEAT_MS = String(HEARTBEAT_MS);
    ({ app, base } = await startApp());
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterEach(() => {
    for (const stream of open.splice(0)) stream.close();
  });

  afterAll(async () => {
    await app.close();
    if (previousHeartbeat === undefined) delete process.env.REALTIME_HEARTBEAT_MS;
    else process.env.REALTIME_HEARTBEAT_MS = previousHeartbeat;
  });

  const post = (token: string, path: string, body: unknown = {}) =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);

  async function stream(
    module: 'reservations' | 'pos',
    token: string | undefined,
    locationId: string,
  ) {
    const client = await openSse(`${base}/${module}/stream?locationId=${locationId}`, token);
    open.push(client);
    return client;
  }
  async function ready(module: 'reservations' | 'pos', token: string, locationId: string) {
    const client = await stream(module, token, locationId);
    expect(client.status).toBe(200);
    await client.next(isEvent('ready'));
    return client;
  }

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return { userId, token: await seed.token(userId, org.id) };
  }

  /** On `full`, a table at each location and a dish to send. */
  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const { token: owner } = await member(org, 'owner');
    const [here, there] = org.locations;
    const tables: Record<string, string> = {};
    for (const locationId of [here, there]) {
      tables[locationId] = diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name: 'T1', seats: 4 }).expect(201)).body,
      ).id;
    }
    const category = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Mains' }).expect(201)).body,
    );
    const dish = productSchema.parse(
      (
        await post(owner, '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        }).expect(201)
      ).body,
    );
    return { org, owner, here, there, tables, dish: dish.id };
  }

  /** Forced: tests run at any hour. Every booking an hour later than the last on that table. */
  let nextStart = 2;
  const book = async (token: string, locationId: string, tableId: string) =>
    reservationSchema.parse(
      (
        await post(token, '/reservations', {
          locationId,
          startsAt: new Date(Date.now() + nextStart++ * 3600_000).toISOString(),
          partySize: 2,
          tableIds: [tableId],
          guest: { name: 'Ada' },
          force: true,
        }).expect(201)
      ).body,
    );

  /** Runs every outbox event of `type` of the org through `handler`, like the worker would. */
  async function deliver(orgId: string, type: EventType, handler: string) {
    const runner = app.get(OutboxEventRunner);
    const events = await seed.as(orgId, (db) =>
      db.outboxEvent.findMany({ where: { type }, orderBy: { id: 'asc' } }),
    );
    for (const e of events) {
      await runner.run({
        eventId: e.id,
        tenantId: orgId,
        type: e.type as EventType,
        version: e.version,
        payload: e.payload as Record<string, unknown>,
        occurredAt: e.occurredAt.toISOString(),
        handler,
      });
    }
    return events.length;
  }

  it('opens with ready (heartbeat, token expiry), then pings, without buffering hints', async () => {
    const r = await restaurant();
    const client = await stream('reservations', r.owner, r.here);
    expect(client.status).toBe(200);
    expect(client.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(client.headers.get('cache-control')).toContain('no-transform');
    expect(client.headers.get('x-accel-buffering')).toBe('no');
    const ready = realtimeReadySchema.parse(
      ((await client.next(isEvent('ready'))) as { data: unknown }).data,
    );
    expect(ready.heartbeatMs).toBe(HEARTBEAT_MS);
    const exp = JSON.parse(Buffer.from(r.owner.split('.')[1]!, 'base64url').toString()) as {
      exp: number;
    };
    expect(ready.expiresAt).toBe(new Date(exp.exp * 1000).toISOString());
    expect(client.items[0]).toEqual({ event: 'ready', data: ready });
    await client.next(isPing, HEARTBEAT_MS * 3);
  });

  it("delivers a booking to its location's streams only, never to another tenant's", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const aHere = await ready('reservations', a.owner, a.here);
    const aThere = await ready('reservations', a.owner, a.there);
    const bHere = await ready('reservations', b.owner, b.here);
    const aPos = await ready('pos', a.owner, a.here);

    const booking = await book(a.owner, a.here, a.tables[a.here]!);
    expect(
      await deliver(a.org.id, 'reservations.reservation.created', 'reservations.publishCreated'),
    ).toBe(1);

    const hint = await aHere.next(isEvent('changed'));
    expect(realtimeChangedSchema.parse((hint as { data: unknown }).data)).toEqual({
      topic: 'reservations',
      ids: [booking.id],
    });
    // Wait past a few pings: nothing else arrives anywhere else.
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 2));
    expect(aThere.events('changed')).toEqual([]);
    expect(bHere.events('changed')).toEqual([]);
    expect(aPos.events('changed')).toEqual([]);

    // A status change and an edit are hints too.
    await post(a.owner, `/reservations/${booking.id}/arrive`).expect(201);
    await deliver(
      a.org.id,
      'reservations.reservation.status_changed',
      'reservations.publishStatusChanged',
    );
    await aHere.next((item) => isEvent('changed')(item) && aHere.events('changed').length === 2);
    expect(bHere.events('changed')).toEqual([]);
  });

  it('delivers orders opened, tickets sent and orders closed to the pos stream of the location', async () => {
    const r = await restaurant();
    const here = await ready('pos', r.owner, r.here);
    const there = await ready('pos', r.owner, r.there);
    const sent = sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/tables/${r.tables[r.here]}/tickets`, {
          lines: [{ productId: r.dish, quantity: 1 }],
        }).expect(201)
      ).body,
    );
    await deliver(r.org.id, 'pos.order.opened', 'pos.publishOrderOpened');
    await deliver(r.org.id, 'pos.kitchen_ticket.created', 'pos.publishKitchenTicket');
    await post(r.owner, `/pos/orders/${sent.order.id}/close`).expect(201);
    await deliver(r.org.id, 'pos.order.closed', 'pos.publishOrderClosed');

    await here.next(() => here.events('changed').length >= 3);
    for (const data of here.events('changed')) {
      expect(realtimeChangedSchema.parse(data)).toEqual({
        topic: 'pos.floor',
        ids: [sent.order.id],
      });
    }
    expect(there.events('changed')).toEqual([]);
  });

  it('checks the token, permission, feature and location on connect', async () => {
    const r = await restaurant();
    expect((await stream('reservations', undefined, r.here)).status).toBe(401);
    const staff = await member(r.org, 'staff');
    for (const module of ['reservations', 'pos'] as const) {
      const denied = await stream(module, staff.token, r.here);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'rbac.permission_denied' });
    }
    // A manager of the other location only: this location doesn't exist for them.
    const branch = await member(r.org, 'manager', [r.there]);
    const hidden = await stream('reservations', branch.token, r.here);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ code: 'reservations.location_not_found' });
    const hiddenPos = await stream('pos', branch.token, r.here);
    expect(hiddenPos.status).toBe(404);
    expect(hiddenPos.body).toMatchObject({ code: 'pos.location_not_found' });
    await ready('reservations', branch.token, r.there);
    // Another tenant's location id: 404 as well.
    const other = await restaurant();
    expect((await stream('reservations', r.owner, other.here)).status).toBe(404);
    expect((await stream('reservations', r.owner, 'not-a-uuid')).status).toBe(400);

    await emptyPlanFor(r.org.id);
    const off = await stream('reservations', r.owner, r.here);
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ code: 'entitlements.feature_disabled' });
  });

  it("ends at the access token's expiry", async () => {
    const r = await restaurant();
    const { userId } = await member(r.org, 'host');
    const tokens = app.get(AccessTokenService);
    // Issued so that it expires 1 s from now.
    const issued = new Date(Date.now() - (tokens.ttlSeconds - 1) * 1000);
    const token = await tokens.sign(
      { userId, organizationId: r.org.id, sessionId: uuidv7() },
      issued,
    );
    const client = await ready('reservations', token, r.here);
    expect(await within(client.ended, 3_000)).toBe(true);
  });

  it('ends a revoked session at its next ping', async () => {
    const r = await restaurant();
    const { userId } = await member(r.org, 'host');
    const sessionId = uuidv7();
    const client = await ready(
      'reservations',
      await seed.token(userId, r.org.id, sessionId),
      r.here,
    );
    await app.get(RevocationService).revokeSession(sessionId);
    expect(await within(client.ended, HEARTBEAT_MS * 4)).toBe(true);
  });

  it('keeps at most 4 streams per session: a fifth ends the oldest', async () => {
    const r = await restaurant();
    const streams: SseClient[] = [];
    for (let i = 0; i < 5; i++) streams.push(await ready('reservations', r.owner, r.here));
    expect(await within(streams[0]!.ended, 2_000)).toBe(true);
    expect(streams.slice(1).map((s) => s.isEnded())).toEqual([false, false, false, false]);
  });

  it('holds no database connection while streams are open: 50 streams, 0 checked out', async () => {
    const r = await restaurant();
    const { userId } = await member(r.org, 'host');
    const tokens = await Promise.all(
      Array.from({ length: 50 }, () => seed.token(userId, r.org.id, uuidv7())),
    );
    const streams = await Promise.all(tokens.map((token) => ready('reservations', token, r.here)));
    expect(streams.every((s) => !s.isEnded())).toBe(true);
    // Let any request tail (logging, idempotency) settle, then look at the pool.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pool = app.get(PrismaService).poolSnapshot();
    expect({ checkedOut: pool.total - pool.idle, waiting: pool.waiting }).toEqual({
      checkedOut: 0,
      waiting: 0,
    });
    // And they still work: one booking reaches all of them.
    const booking = await book(r.owner, r.here, r.tables[r.here]!);
    await deliver(r.org.id, 'reservations.reservation.created', 'reservations.publishCreated');
    await Promise.all(
      streams.map((s) =>
        s.next((item) => isEvent('changed')(item) && JSON.stringify(item).includes(booking.id)),
      ),
    );
  });

  it("tells open streams to resync when the api's Redis subscriber reconnects", async () => {
    const r = await restaurant();
    const client = await ready('reservations', r.owner, r.here);
    await app.get(RealtimeHub).reconnectForTest();
    await client.next(isEvent('resync'), 5_000);
    // Still subscribed afterwards.
    const booking = await book(r.owner, r.here, r.tables[r.here]!);
    await deliver(r.org.id, 'reservations.reservation.created', 'reservations.publishCreated');
    await client.next(
      (item) => isEvent('changed')(item) && JSON.stringify(item).includes(booking.id),
    );
  });
});

describe('realtime streams on shutdown', () => {
  it('ends every open stream so the api can stop', async () => {
    const { app, base } = await startApp();
    const seed = new RbacSeed(app);
    const org = await seed.org();
    await app.get(EntitlementsAdmin).setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    const client = await openSse(
      `${base}/reservations/stream?locationId=${org.locations[0]}`,
      await seed.token(userId, org.id),
    );
    await client.next(isEvent('ready'));
    expect(await within(app.close(), 5_000)).toBe(true);
    expect(await within(client.ended, 1_000)).toBe(true);
  });
});
