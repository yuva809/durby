import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, it, vi } from 'vitest';

// Config is read when the modules compile: the env must be set before the imports below run.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://durby_app:unused@127.0.0.1:1/durby',
    REDIS_URL: 'redis://127.0.0.1:1',
    JWT_ACCESS_SECRET: 'test-only-jwt-secret-0123456789abcdef',
    WEB_ORIGINS: 'http://web.test',
    WEB_BASE_URL: 'http://web.test',
    SMTP_URL: 'smtp://127.0.0.1:1',
    MAIL_FROM: 'Durby <no-reply@durby.test>',
    STAFF_EMAIL_DOMAINS: 'durby.test',
  });
});

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/platform/database';
import { RedisService } from '../src/platform/redis';

let app: INestApplication | undefined;

afterAll(async () => {
  await app?.close();
});

/**
 * The api boots: the whole module graph resolves and every boot check passes (route markers, idempotency markers,
 * outbox handlers, settings checks). Postgres and Redis are not connected, so this runs without Docker; a release that
 * would crash-loop on staging (deploy "did not become healthy") fails here first.
 */
it('boots with every boot check passing', async () => {
  vi.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue(undefined);
  vi.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue(undefined);
  vi.spyOn(RedisService.prototype, 'onModuleInit').mockResolvedValue(undefined);
  vi.spyOn(RedisService.prototype, 'onModuleDestroy').mockResolvedValue(undefined);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
}, 60_000);
