import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { diningTableSchema, productCategorySchema, productSchema } from '@durby/shared';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { PrismaService } from '../src/platform/database';
import { RbacSeed } from './support/rbac';

/**
 * ADR 0021: when a request waits too long for the database (here: no pooled connection within
 * Prisma's maxWait, already in the guards), any route answers 503 platform.busy with Retry-After,
 * and the same Idempotency-Key runs the write again.
 */
describe('database overload on any route', () => {
  let app: INestApplication;
  let server: App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 503 platform.busy with Retry-After, and a retry with the same key works', async () => {
    const seed = new RbacSeed(app);
    const org = await seed.org();
    await app.get(EntitlementsAdmin).setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    const token = await seed.token(userId, org.id);
    const post = (path: string, body: unknown, key = uuidv7()) =>
      request(server)
        .post(`/api/v1${path}`)
        .set('Idempotency-Key', key)
        .auth(token, { type: 'bearer' })
        .send(body as object);
    const table = async (name: string) =>
      diningTableSchema.parse(
        (await post('/pos/tables', { locationId: org.locations[0], name, seats: 4 }).expect(201))
          .body,
      ).id;
    const t2 = await table('T1');
    const category = productCategorySchema.parse(
      (await post('/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const soup = productSchema.parse(
      (
        await post('/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        }).expect(201)
      ).body,
    );
    const ticket = { lines: [{ productId: soup.id, quantity: 1 }] };

    // Every pooled connection busy for 4 s (the pool holds 10): the next request can't get one
    // within Prisma's 2 s maxWait, already in its first guard.
    const prisma = app.get(PrismaService);
    const sleepers = Array.from({ length: 10 }, () =>
      prisma.$transaction((tx) => tx.$executeRaw`SELECT pg_sleep(4)`, { timeout: 10_000 }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const key = uuidv7();
    const busy = await post(`/pos/tables/${t2}/tickets`, ticket, key).expect(503);
    expect(busy.body).toEqual({
      code: 'platform.busy',
      message: 'The service is busy. Retry shortly.',
    });
    expect(busy.headers['retry-after']).toBe('2');
    await Promise.all(sleepers);
    // 5xx isn't stored: the same key runs the write.
    await post(`/pos/tables/${t2}/tickets`, ticket, key).expect(201);
  }, 30_000);

  it('answers 503 platform.busy when a row lock is held past the 4 s lock_timeout', async () => {
    const seed = new RbacSeed(app);
    const org = await seed.org();
    await app.get(EntitlementsAdmin).setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    const token = await seed.token(userId, org.id);
    const send = (method: 'post' | 'patch', path: string, body: object, key = uuidv7()) =>
      request(server)
        [method](`/api/v1${path}`)
        .set('Idempotency-Key', key)
        .auth(token, { type: 'bearer' })
        .send(body);
    const table = diningTableSchema.parse(
      (
        await send('post', '/pos/tables', {
          locationId: org.locations[0],
          name: 'T1',
          seats: 4,
        }).expect(201)
      ).body,
    );

    // Another connection holds the table's row lock for longer than the api waits.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.tenant_id', $1, true)`, [org.id]);
      await holder.query('SELECT id FROM dining_tables WHERE id = $1 FOR UPDATE', [table.id]);
      const key = uuidv7();
      const started = Date.now();
      const busy = await send('patch', `/pos/tables/${table.id}`, { name: 'T1a' }, key).expect(503);
      expect(Date.now() - started).toBeGreaterThanOrEqual(3_500);
      expect(busy.body).toMatchObject({ code: 'platform.busy' });
      expect(busy.headers['retry-after']).toBe('2');
      await holder.query('ROLLBACK');
      await send('patch', `/pos/tables/${table.id}`, { name: 'T1a' }, key).expect(200);
    } finally {
      await holder.end();
    }
  }, 30_000);
});
