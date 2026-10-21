import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { healthResponseSchema, liveResponseSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RedisService } from '../src/platform/redis';

async function startApp(override?: (builder: TestingModuleBuilder) => void) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  override?.(builder);
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

describe('GET /api/v1/health', () => {
  let app: INestApplication;
  let server: App;

  beforeAll(async () => {
    app = await startApp();
    server = app.getHttpServer() as App;
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok with database and Redis up', async () => {
    const res = await request(server).get('/api/v1/health').expect(200);
    expect(healthResponseSchema.parse(res.body)).toMatchObject({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('answers liveness', async () => {
    const res = await request(server).get('/api/v1/health/live').expect(200);
    expect(liveResponseSchema.parse(res.body).status).toBe('ok');
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const kept = await request(server).get('/api/v1/health/live').set('X-Request-Id', 'caddy-123');
    expect(kept.headers['x-request-id']).toBe('caddy-123');

    const generated = await request(server)
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'bad id');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is not served without the api/v1 prefix', async () => {
    await request(server).get('/health').expect(404);
  });
});

describe('GET /api/v1/health with Redis down', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await startApp((builder) => {
      builder.overrideProvider(RedisService).useValue({
        ping: () => Promise.reject(new Error('ECONNREFUSED')),
        onModuleInit: () => Promise.resolve(),
        onModuleDestroy: () => Promise.resolve(),
      });
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 degraded, while liveness stays ok', async () => {
    const server = app.getHttpServer() as App;
    const res = await request(server).get('/api/v1/health').expect(503);
    expect(healthResponseSchema.parse(res.body)).toMatchObject({
      status: 'degraded',
      checks: { database: 'up', redis: 'down' },
    });
    await request(server).get('/api/v1/health/live').expect(200);
  });
});
