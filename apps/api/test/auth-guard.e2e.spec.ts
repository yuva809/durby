import { Controller, Get, Inject, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthContext, Authenticated, Public } from '../src/platform/auth';
import { AccessTokenService } from '../src/platform/auth/access-token.service';
import { RevocationService } from '../src/platform/auth/revocation.service';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../src/platform/tenancy';
import { IdempotencyExempt } from '../src/platform/idempotency';
import { planIdOf } from './support/plans';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/** Test-only routes that report what the guard put into the request scope. */
@Controller('probe')
class ProbeController {
  constructor(
    private readonly auth: AuthContext,
    private readonly tenant: TenantContext,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
  ) {}

  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }

  /** Token only (a test probe). Reads the context after awaits and in a lazy query. */
  @Authenticated()
  @Get('context')
  async context(): Promise<unknown> {
    await tick();
    const [row] = await this.db.$queryRaw<{ tenant: string }[]>`
      SELECT current_setting('app.tenant_id', true) AS tenant`;
    await tick();
    return { auth: this.auth.get(), tenant: this.tenant.get()?.tenantId, dbTenant: row?.tenant };
  }

  @Authenticated()
  @IdempotencyExempt('test probe: reads the request context only')
  @Post('context')
  contextViaPost(): Promise<unknown> {
    return this.context();
  }

  @Authenticated()
  @Get('brands')
  async brands(): Promise<{ count: number }> {
    return { count: await this.db.brand.count() };
  }
}

describe('Authenticator (via AccessGuard)', () => {
  let app: INestApplication;
  let server: App;
  let tokens: AccessTokenService;
  let revocations: RevocationService;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    // Listen once, so parallel supertest requests share the server instead of binding one each.
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as App;
    tokens = app.get(AccessTokenService);
    revocations = app.get(RevocationService);

    const platform = app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
    const partner = await platform.partner.create({ data: { slug: `t-${uuidv7()}`, name: 'P' } });
    [orgA, orgB] = (await Promise.all(
      ['A', 'B'].map(
        async (name) =>
          (
            await platform.organization.create({
              data: { partnerId: partner.id, name, planId: await planIdOf(platform) },
            })
          ).id,
      ),
    )) as [string, string];
  });

  afterAll(async () => {
    await app.close();
  });

  const tokenFor = (organizationId: string | null, over: { at?: Date; sessionId?: string } = {}) =>
    tokens.sign(
      { userId: uuidv7(), organizationId, sessionId: over.sessionId ?? uuidv7() },
      over.at,
    );

  it('lets @Public() routes through without a token', async () => {
    await request(server).get('/api/v1/probe/public').expect(200, { ok: true });
    await request(server).get('/api/v1/health/live').expect(200);
  });

  it.each([
    ['no header', undefined],
    ['not Bearer', 'Basic ZHVyYnk6c2VjcmV0'],
    ['empty Bearer', 'Bearer '],
    ['garbage', 'Bearer not-a-token'],
  ])('rejects token routes with %s: 401 auth.unauthenticated', async (_, header) => {
    const req = request(server).get('/api/v1/probe/context');
    if (header !== undefined) req.set('Authorization', header);
    const res = await req.expect(401);
    expect(res.body).toMatchObject({ code: 'auth.unauthenticated' });
  });

  it('rejects an expired token', async () => {
    const token = await tokenFor(orgA, { at: new Date(Date.now() - 3_600_000) });
    await request(server).get('/api/v1/probe/context').auth(token, { type: 'bearer' }).expect(401);
  });

  it('rejects a revoked session at once', async () => {
    const sessionId = uuidv7();
    const token = await tokenFor(orgA, { sessionId });
    await request(server).get('/api/v1/probe/context').auth(token, { type: 'bearer' }).expect(200);
    await revocations.revokeSession(sessionId);
    await request(server).get('/api/v1/probe/context').auth(token, { type: 'bearer' }).expect(401);
  });

  it('fills AuthContext and TenantContext from the token, visible after awaits and in lazy queries', async () => {
    const sessionId = uuidv7();
    const token = await tokenFor(orgA, { sessionId });
    const res = await request(server)
      .get('/api/v1/probe/context')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body).toEqual({
      auth: {
        userId: expect.any(String) as unknown,
        organizationId: orgA,
        sessionId,
        passwordChangeRequired: false,
        // The token's iat and exp: streams end at exp (ADR 0044 §7).
        issuedAt: expect.any(Number) as unknown,
        expiresAt: expect.any(Number) as unknown,
      },
      tenant: orgA,
      dbTenant: orgA,
    });
  });

  it('never takes the tenant from headers, query or body', async () => {
    const token = await tokenFor(orgA);
    const viaQuery = await request(server)
      .get(`/api/v1/probe/context?tenantId=${orgB}&organizationId=${orgB}`)
      .set('X-Tenant-Id', orgB)
      .set('X-Organization-Id', orgB)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(viaQuery.body).toMatchObject({ tenant: orgA, dbTenant: orgA });

    const viaBody = await request(server)
      .post('/api/v1/probe/context')
      .send({ tenantId: orgB, organizationId: orgB })
      .auth(token, { type: 'bearer' })
      .expect(201);
    expect(viaBody.body).toMatchObject({ tenant: orgA, dbTenant: orgA });
  });

  it('keeps parallel requests of different tenants apart', async () => {
    const [a, b] = await Promise.all([tokenFor(orgA), tokenFor(orgB)]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(server)
          .get('/api/v1/probe/context')
          .auth(i % 2 ? b : a, { type: 'bearer' }),
      ),
    );
    results.forEach((res, i) =>
      expect(res.body).toMatchObject({
        tenant: i % 2 ? orgB : orgA,
        dbTenant: i % 2 ? orgB : orgA,
      }),
    );
  });

  it('a token without an active organization gets no tenant: tenant data is 403', async () => {
    const token = await tokenFor(null);
    const ctx = await request(server).get('/api/v1/probe/context').auth(token, { type: 'bearer' });
    // The probe's raw query runs on the tenant client, which refuses without a tenant.
    expect(ctx.status).toBe(403);
    const res = await request(server)
      .get('/api/v1/probe/brands')
      .auth(token, { type: 'bearer' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'tenancy.context_missing' });
  });
});
