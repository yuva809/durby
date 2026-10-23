import { Body, Controller, type INestApplication, Inject, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IDEMPOTENT_REPLAYED_HEADER } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Idempotent, IdempotencyService } from '../src/platform/idempotency';
import { OutboxCleanup, OutboxService } from '../src/platform/outbox';
import { RequirePermission } from '../src/platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** Requests parked inside a test route until the test releases them, in arrival order. */
const parked: (() => void)[] = [];
const park = () => new Promise<void>((resolve) => parked.push(resolve));
const control = { fail: false };

/** Test-only routes: a "business write" is one outbox row (counted by the tests). */
@Controller('idem-test')
class IdemTestController {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private write(tx: Parameters<Parameters<TenantPrismaClient['$transaction']>[0]>[0]) {
    return this.outbox.add(tx, { type: 'config.entitlements.changed', payload: {} });
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Post('write')
  async writeOnce(@Body() body: { wait?: boolean }): Promise<{ id: string }> {
    if (body.wait) await park();
    if (control.fail) throw new Error('unexpected failure');
    return { id: await this.db.$transaction((tx) => this.write(tx)) };
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Post('secret')
  async secret(): Promise<{ id: string; accessToken: string }> {
    return { id: await this.db.$transaction((tx) => this.write(tx)), accessToken: 'x' };
  }

  /** Commits the write and then fails, like a process dying before the response is stored. */
  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Post('commit-then-fail')
  async commitThenFail(): Promise<void> {
    await this.db.$transaction((tx) => this.write(tx));
    throw new Error('crashed after commit');
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post('tx-commit-then-fail')
  async txCommitThenFail(): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const id = await this.write(tx);
      await this.idempotency.completeInTransaction(tx, { id });
    });
    throw new Error('crashed after commit');
  }

  /** Parks inside its business transaction (when asked) right before completing in it. */
  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post('tx-write')
  async txWrite(@Body() body: { wait?: boolean }): Promise<{ id: string }> {
    return this.db.$transaction(
      async (tx) => {
        const id = await this.write(tx);
        if (body.wait && parked.length === 0 && !control.fail) await park();
        const response = { id };
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      },
      { timeout: 20_000 },
    );
  }

  /** Forgets completeInTransaction: still stored by the interceptor, and logged. */
  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post('tx-forgot')
  async txForgot(): Promise<{ id: string }> {
    return { id: await this.db.$transaction((tx) => this.write(tx)) };
  }
}

/** docs/platform/idempotency.md → Behaviour, Transaction completion (ADR 0014). */
describe('Idempotency-Key', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [IdemTestController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    control.fail = false;
  });

  async function owner(org?: SeededOrg): Promise<{ org: SeededOrg; token: string }> {
    const o = org ?? (await seed.org());
    const userId = await seed.user();
    await seed.member(o.id, userId, o.roles.owner);
    return { org: o, token: await seed.token(userId, o.id) };
  }

  const post = (token: string, path: string, key: string | undefined, body: object = {}) => {
    const req = request(server).post(`/api/v1/idem-test/${path}`).auth(token, { type: 'bearer' });
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  };

  const putSetting = (token: string, key: string | undefined, value: unknown) => {
    const req = request(server).put('/api/v1/settings/timezone').auth(token, { type: 'bearer' });
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send({ value });
  };

  /** Business writes of the test routes in `orgId`. */
  const writes = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.outboxEvent.count({ where: { type: 'config.entitlements.changed' } }),
    );

  const keyRow = (orgId: string, key: string) =>
    seed.as(orgId, (db) => db.idempotencyKey.findFirst({ where: { key } }));

  async function untilParked(n = 1): Promise<void> {
    for (let i = 0; i < 400 && parked.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    expect(parked.length).toBeGreaterThanOrEqual(n);
  }

  const expireLock = (orgId: string, key: string) =>
    seed.as(
      orgId,
      (db) =>
        db.$executeRaw`UPDATE idempotency_keys SET locked_until = now() - interval '1 second'
        WHERE key = ${key}`,
    );

  describe('header', () => {
    it('is required, and refused when malformed', async () => {
      const { token } = await owner();
      expect((await putSetting(token, undefined, 'UTC').expect(400)).body).toMatchObject({
        code: 'idempotency.key_required',
      });
      expect((await putSetting(token, 'has space', 'UTC').expect(400)).body).toMatchObject({
        code: 'idempotency.key_invalid',
      });
      expect((await putSetting(token, 'x'.repeat(256), 'UTC').expect(400)).body).toMatchObject({
        code: 'idempotency.key_invalid',
      });
    });

    it('creates no record for a request the guards refuse', async () => {
      const org = await seed.org();
      const userId = await seed.user();
      await seed.member(org.id, userId, org.roles.staff);
      const key = uuidv7();
      await putSetting(await seed.token(userId, org.id), key, 'UTC').expect(403);
      expect(await keyRow(org.id, key)).toBeNull();
    });
  });

  describe('replay', () => {
    it('returns an identical status and body without writing again', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = await putSetting(token, key, 'Europe/Berlin').expect(200);
      const second = await putSetting(token, key, 'Europe/Berlin').expect(200);
      expect(second.body).toEqual(first.body);
      expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
      expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
      const audit = await seed.as(org.id, (db) =>
        db.auditLog.count({ where: { action: { startsWith: 'platform.setting_value' } } }),
      );
      expect(audit).toBe(1);
    });

    it('replays 201 bodies of POST routes and 204 of DELETE routes', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = await post(token, 'write', key).expect(201);
      expect((await post(token, 'write', key).expect(201)).body).toEqual(first.body);
      expect(await writes(org.id)).toBe(1);

      await putSetting(token, uuidv7(), 'UTC').expect(200);
      const delKey = uuidv7();
      const del = () =>
        request(server)
          .delete('/api/v1/settings/timezone')
          .auth(token, { type: 'bearer' })
          .set('Idempotency-Key', delKey);
      await del().expect(204);
      const replayed = await del().expect(204);
      expect(replayed.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    });

    it('replays a decided 4xx, with its code', async () => {
      const { token } = await owner();
      const key = uuidv7();
      const first = await putSetting(token, key, 'Mars/Olympus').expect(422);
      const second = await putSetting(token, key, 'Mars/Olympus').expect(422);
      expect(second.body).toEqual(first.body);
      expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    });

    it('refuses the same key with a different body or query: 422', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      await putSetting(token, key, 'Europe/Berlin').expect(200);
      expect((await putSetting(token, key, 'Europe/Vienna').expect(422)).body).toMatchObject({
        code: 'idempotency.key_reused',
      });
      await request(server)
        .put(`/api/v1/settings/timezone?locationId=${org.locations[0]}`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send({ value: 'Europe/Berlin' })
        .expect(422);
    });

    it('deletes expired keys in the retention pass, keeps live ones', async () => {
      const { org, token } = await owner();
      const [old, live] = [uuidv7(), uuidv7()];
      await post(token, 'write', old).expect(201);
      await post(token, 'write', live).expect(201);
      await seed.as(
        org.id,
        (db) =>
          db.$executeRaw`UPDATE idempotency_keys
          SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
          WHERE key = ${old}`,
      );
      const counts = await app.get(OutboxCleanup).runOnce();
      expect(counts.idempotencyKeys).toBeGreaterThanOrEqual(1);
      expect(await keyRow(org.id, old)).toBeNull();
      expect(await keyRow(org.id, live)).not.toBeNull();
    });

    it('treats a key older than 24 hours as new', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      await post(token, 'write', key).expect(201);
      await seed.as(
        org.id,
        (db) =>
          db.$executeRaw`UPDATE idempotency_keys
          SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
          WHERE key = ${key}`,
      );
      const again = await post(token, 'write', key).expect(201);
      expect(again.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
      expect(await writes(org.id)).toBe(2);
    });
  });

  describe('scope', () => {
    it('keeps keys apart per user, organization and route', async () => {
      const a = await owner();
      const a2 = await owner(a.org);
      const b = await owner();
      const key = uuidv7();
      await post(a.token, 'write', key).expect(201);
      for (const [token, path] of [
        [a2.token, 'write'],
        [b.token, 'write'],
        [a.token, 'secret'],
      ] as const) {
        const res = await post(token, path, key).expect(201);
        expect(res.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
      }
      expect(await writes(a.org.id)).toBe(3);
      expect(await writes(b.org.id)).toBe(1);
      // RLS: organization B sees none of A's keys.
      expect((await keyRow(b.org.id, key))?.tenantId).toBe(b.org.id);
      expect(
        await seed.as(b.org.id, (db) => db.idempotencyKey.count({ where: { tenantId: a.org.id } })),
      ).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('answers 409 while the first request runs, then replays its result', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = post(token, 'write', key, { wait: true }).then((r) => r);
      await untilParked();
      expect((await post(token, 'write', key, { wait: true }).expect(409)).body).toMatchObject({
        code: 'idempotency.request_in_progress',
      });
      parked.shift()?.();
      const done = await first;
      expect(done.status).toBe(201);
      expect((await post(token, 'write', key, { wait: true }).expect(201)).body).toEqual(done.body);
      expect(await writes(org.id)).toBe(1);
    });

    it('lets a retry take over a stale lock (default path: the write may run twice)', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = post(token, 'write', key, { wait: true }).then((r) => r);
      await untilParked();
      await expireLock(org.id, key);
      const second = post(token, 'write', key, { wait: true }).then((r) => r);
      await untilParked(2);
      parked.shift()?.();
      parked.shift()?.();
      expect((await first).status).toBe(201);
      expect((await second).status).toBe(201);
      // The documented window of the default path (ADR 0014 §6).
      expect(await writes(org.id)).toBe(2);
    });
  });

  describe('results that are not stored', () => {
    it('releases the key on a 5xx so a retry runs again', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      control.fail = true;
      await post(token, 'write', key).expect(500);
      expect(await keyRow(org.id, key)).toBeNull();
      control.fail = false;
      const retried = await post(token, 'write', key).expect(201);
      expect(retried.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
      expect(await writes(org.id)).toBe(1);
    });

    it('never stores a body with token-like fields', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      await post(token, 'secret', key).expect(201);
      expect(await keyRow(org.id, key)).toBeNull();
    });
  });

  describe('transaction completion (ADR 0014 §6)', () => {
    it('default path: a crash after commit re-runs the write on retry', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      await post(token, 'commit-then-fail', key).expect(500);
      await post(token, 'commit-then-fail', key).expect(500);
      expect(await writes(org.id)).toBe(2);
    });

    it('a crash after commit replays the stored result: the write runs once', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      await post(token, 'tx-commit-then-fail', key).expect(500);
      expect(await keyRow(org.id, key)).toMatchObject({ status: 'completed', responseStatus: 201 });
      const retry = await post(token, 'tx-commit-then-fail', key).expect(201);
      expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
      expect(await writes(org.id)).toBe(1);
    });

    it('stores the result with the change and replays it', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = await post(token, 'tx-write', key).expect(201);
      expect(await keyRow(org.id, key)).toMatchObject({
        status: 'completed',
        responseBody: first.body as unknown,
      });
      expect((await post(token, 'tx-write', key).expect(201)).body).toEqual(first.body);
      expect(await writes(org.id)).toBe(1);
    });

    it('rolls back a slow original whose lock was taken over: one write in total', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = post(token, 'tx-write', key, { wait: true }).then((r) => r);
      await untilParked();
      await expireLock(org.id, key);
      // The takeover completes while the original is still parked inside its transaction.
      const second = await post(token, 'tx-write', key, { wait: true }).expect(201);
      parked.shift()?.();
      const original = await first;
      expect(original.status).toBe(409);
      expect(original.body).toMatchObject({ code: 'idempotency.request_in_progress' });
      expect(await writes(org.id)).toBe(1);
      expect((await post(token, 'tx-write', key, { wait: true }).expect(201)).body).toEqual(
        second.body,
      );
    });

    it('still stores the result when a route forgets completeInTransaction', async () => {
      const { org, token } = await owner();
      const key = uuidv7();
      const first = await post(token, 'tx-forgot', key).expect(201);
      expect((await post(token, 'tx-forgot', key).expect(201)).body).toEqual(first.body);
      expect(await writes(org.id)).toBe(1);
    });
  });
});
