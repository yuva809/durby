import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_THEME, themeResponseSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/** docs/platform/web-shell.md → Resolution. The demo partner comes from the migration. */
describe('GET /api/v1/theme', () => {
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

  const theme = (headers: Record<string, string>) => {
    const req = request(server).get('/api/v1/theme');
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req.expect(200);
  };

  it('returns the demo partner theme for its host, without an auth header', async () => {
    const res = await theme({ Host: 'partner-demo.localhost:3000' });
    const body = themeResponseSchema.parse(res.body);
    expect(body).toMatchObject({ productName: 'Gastro Demo', logoUrl: null });
    expect(body.tokens).toMatchObject({
      primary: '#0f766e',
      primaryForeground: '#ffffff',
      foreground: '#0b1f2a',
      background: '#f4f8f8',
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('honors X-Forwarded-Host behind the trusted proxy (TRUST_PROXY=1 in tests)', async () => {
    const res = await theme({ Host: 'api:4000', 'X-Forwarded-Host': 'Partner-Demo.Durby.Tech' });
    expect(res.body).toMatchObject({ productName: 'Gastro Demo' });
  });

  it.each([
    ['an unknown host', { Host: 'unknown.example.com' }],
    ['localhost', { Host: 'localhost:4000' }],
    ['an IP address', { Host: '127.0.0.1:4000' }],
    ['a malformed forwarded host', { 'X-Forwarded-Host': 'evil host!' }],
  ])('returns the default theme for %s', async (_case, headers) => {
    const res = await theme(headers);
    expect(res.body).toEqual(DEFAULT_THEME);
  });

  // ADR 0044: AsiaMight's migration picks the operations sidebar; other partners keep the default.
  it('returns the partner sidebar layout', async () => {
    expect((await theme({ Host: 'app.asiamight.site' })).body).toMatchObject({
      productName: 'AsiaMight',
      navLayout: 'operations',
    });
    expect((await theme({ Host: 'partner-demo.localhost' })).body).toMatchObject({
      navLayout: 'default',
    });
  });

  it('carries no partner or tenant identifiers', async () => {
    const res = await theme({ Host: 'partner-demo.localhost' });
    expect(Object.keys(res.body as object).sort()).toEqual([
      'logoUrl',
      'navLayout',
      'productName',
      'tokens',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});
