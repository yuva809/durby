import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { OutboxPayloadInvalidError, OutboxService } from '../src/platform/outbox';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { withIdempotencyKey } from './support/idempotency';

/** docs/platform/outbox.md → Writing events, and the config events of the writers. */
describe('outbox events', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let outbox: OutboxService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    outbox = app.get(OutboxService);
  });

  afterAll(async () => {
    await app.close();
  });

  const events = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.outboxEvent.findMany({
        select: { type: true, version: true, payload: true, publishedAt: true },
        orderBy: { id: 'asc' },
      }),
    );

  async function owner(): Promise<{ org: SeededOrg; token: string }> {
    const org = await seed.org();
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    return { org, token: await seed.token(userId, org.id) };
  }

  const send = (token: string, method: 'put' | 'patch' | 'delete', path: string, body?: object) =>
    withIdempotencyKey(
      request(server)[method](`/api/v1${path}`).auth(token, { type: 'bearer' }),
    ).send(body);

  describe('OutboxService.add', () => {
    const event = (orgId: string) => ({
      type: 'config.settings.changed' as const,
      payload: { scope: 'organization' as const, scopeId: orgId, key: 'timezone' },
    });

    it('leaves no row when the business transaction rolls back', async () => {
      const { id } = await seed.org();
      await expect(
        seed.as(id, (db) =>
          db.$transaction(async (tx) => {
            await outbox.add(tx, event(id));
            throw new Error('business write failed');
          }),
        ),
      ).rejects.toThrow('business write failed');
      expect(await events(id)).toEqual([]);
    });

    it('leaves exactly one unpublished row when it commits', async () => {
      const { id } = await seed.org();
      await seed.as(id, (db) => db.$transaction((tx) => outbox.add(tx, event(id))));
      expect(await events(id)).toEqual([
        {
          type: 'config.settings.changed',
          version: 1,
          payload: event(id).payload,
          publishedAt: null,
        },
      ]);
    });

    it('rejects a payload outside its schema', async () => {
      const { id } = await seed.org();
      const bad = { ...event(id), payload: { ...event(id).payload, email: 'a@b.test' } };
      await expect(
        seed.as(id, (db) => db.$transaction((tx) => outbox.add(tx, bad as never))),
      ).rejects.toBeInstanceOf(OutboxPayloadInvalidError);
    });
  });

  describe('config events', () => {
    it('settings: one event per change, none for a no-op, with the scope id', async () => {
      const { org, token } = await owner();
      const location = org.locations[0];
      await send(token, 'put', '/settings/timezone', { value: 'Europe/Berlin' }).expect(200);
      await send(token, 'put', '/settings/timezone', { value: 'Europe/Berlin' }).expect(200);
      await send(token, 'put', `/settings/timezone?locationId=${location}`, {
        value: 'Europe/Vienna',
      }).expect(200);
      await send(token, 'delete', '/settings/timezone').expect(204);
      await send(token, 'delete', '/settings/timezone').expect(204);
      expect((await events(org.id)).map((e) => e.payload)).toEqual([
        { scope: 'organization', scopeId: org.id, key: 'timezone' },
        { scope: 'location', scopeId: location, key: 'timezone' },
        { scope: 'organization', scopeId: org.id, key: 'timezone' },
      ]);
    });

    it('labels: one event per change, none for a no-op', async () => {
      const { org, token } = await owner();
      await send(token, 'put', '/label-overrides/en/inventory.nav.title', {
        value: 'Products',
      }).expect(200);
      await send(token, 'put', '/label-overrides/en/inventory.nav.title', {
        value: 'Products',
      }).expect(200);
      await send(token, 'delete', '/label-overrides/en/inventory.nav.title').expect(204);
      expect(await events(org.id)).toMatchObject([
        { type: 'config.labels.changed', payload: { locale: 'en', key: 'inventory.nav.title' } },
        { type: 'config.labels.changed', payload: { locale: 'en', key: 'inventory.nav.title' } },
      ]);
    });

    it('number series: format and counter changes, none for no-ops', async () => {
      const { org, token } = await owner();
      await send(token, 'patch', '/number-series/billing.invoice', { prefix: 'RE' }).expect(200);
      await send(token, 'patch', '/number-series/billing.invoice', { prefix: 'RE' }).expect(200);
      await send(token, 'put', '/number-series/billing.invoice/counter', {
        nextValue: '100',
      }).expect(200);
      await send(token, 'put', '/number-series/billing.invoice/counter', {
        nextValue: '100',
      }).expect(200);
      expect((await events(org.id)).map((e) => [e.type, e.payload])).toEqual([
        ['config.number_series.changed', { key: 'billing.invoice', change: 'format' }],
        ['config.number_series.changed', { key: 'billing.invoice', change: 'counter' }],
      ]);
    });

    it('entitlements: one event per plan or override change, none for no-ops', async () => {
      const { id } = await seed.org();
      const admin = app.get(EntitlementsAdmin);
      await admin.setPlan(id, 'inventory', 'cli.entitlements');
      await admin.setPlan(id, 'inventory', 'cli.entitlements');
      await admin.setOverride(id, 'inventory.counts', false, undefined, 'cli.entitlements');
      await admin.clearOverride(id, 'inventory.counts', 'cli.entitlements');
      await admin.clearOverride(id, 'inventory.counts', 'cli.entitlements');
      const rows = await events(id);
      expect(rows.map((e) => e.type)).toEqual(Array(3).fill('config.entitlements.changed'));
      expect(rows.every((e) => JSON.stringify(e.payload) === '{}')).toBe(true);
    });

    it('a write refused by validation leaves no event', async () => {
      const { org, token } = await owner();
      await send(token, 'put', '/settings/timezone', { value: 'Mars/Olympus' }).expect(422);
      expect(await events(org.id)).toEqual([]);
    });
  });
});
