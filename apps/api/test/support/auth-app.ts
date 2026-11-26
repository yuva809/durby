import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { expect } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { LoggerModule } from 'nestjs-pino';
import { Clock } from '../../src/platform/auth/clock';
import { PasswordHasher } from '../../src/platform/auth/password-hasher';
import { loadConfig } from '../../src/platform/config';
import { PrismaService } from '../../src/platform/database';
import { buildPinoHttpOptions, LoggingModule } from '../../src/platform/logging';
import { InMemoryMailer, MAILER } from '../../src/platform/mail';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../../src/platform/tenancy';
import { FakeClock } from './fake-clock';
import { planIdOf } from './plans';

export const WEB_ORIGIN = 'http://web.test';
export const COOKIE = '__Secure-durby_rt';
export const PASSWORD = 'correct horse battery staple';

/**
 * The api with mail captured in memory and a clock tests can move. With `logs`, every log line
 * (trace level, JSON) is appended to it.
 */
export async function startAuthApp(opts: { logs?: string[] } = {}) {
  const mailer = new InMemoryMailer();
  const clock = new FakeClock(new Date());
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .overrideProvider(Clock)
    .useValue(clock);
  const { logs } = opts;
  if (logs) {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    builder = builder.overrideModule(LoggingModule).useModule(
      LoggerModule.forRoot({
        pinoHttp: [{ ...buildPinoHttpOptions(loadConfig()), level: 'trace' }, stream],
      }),
    );
  }
  const moduleRef = await builder.compile();
  const app: INestApplication = configureApp(moduleRef.createNestApplication());
  await app.listen(0, '127.0.0.1');
  return new AuthTestKit(app, mailer, clock);
}

export class AuthTestKit {
  readonly server: App;
  readonly raw: PrismaService;
  private readonly platformDb: PlatformPrismaClient;
  private readonly tenantDb: TenantPrismaClient;
  private readonly tenantContext: TenantContext;
  private readonly hasher: PasswordHasher;
  private partnerId?: string;

  constructor(
    readonly app: INestApplication,
    readonly mailer: InMemoryMailer,
    readonly clock: FakeClock,
  ) {
    this.server = app.getHttpServer() as App;
    this.raw = app.get(PrismaService);
    this.platformDb = app.get(PLATFORM_PRISMA);
    this.tenantDb = app.get(TENANT_PRISMA);
    this.tenantContext = app.get(TenantContext);
    this.hasher = app.get(PasswordHasher);
  }

  close(): Promise<void> {
    return this.app.close();
  }

  /** A client with its own IP, so per-IP rate limits of one test never hit another. */
  client(ip = randomIp()) {
    const withHeaders = (req: request.Test, origin: string | null) => {
      req.set('X-Forwarded-For', ip);
      if (origin !== null) req.set('Origin', origin);
      return req;
    };
    return {
      ip,
      post: (path: string, origin: string | null = WEB_ORIGIN) =>
        withHeaders(request(this.server).post(`/api/v1/auth${path}`), origin),
      get: (path: string) => withHeaders(request(this.server).get(`/api/v1/auth${path}`), null),
    };
  }

  async createOrg(name: string): Promise<string> {
    this.partnerId ??= (
      await this.platformDb.partner.create({ data: { slug: `t-${uuidv7()}`, name: 'Partner' } })
    ).id;
    return (
      await this.platformDb.organization.create({
        data: { partnerId: this.partnerId, name, planId: await planIdOf(this.platformDb) },
      })
    ).id;
  }

  async createUser(
    opts: { password?: string | null; verified?: boolean; orgs?: string[]; locale?: string } = {},
  ): Promise<{ id: string; email: string }> {
    const email = `user-${uuidv7()}@example.test`;
    const password = opts.password === undefined ? PASSWORD : opts.password;
    const user = await this.raw.user.create({
      data: {
        email,
        passwordHash: password === null ? null : await this.hasher.hash(password),
        emailVerifiedAt: opts.verified === false ? null : new Date(),
        locale: opts.locale ?? 'en',
      },
    });
    for (const org of opts.orgs ?? []) await this.join(org, user.id);
    return { id: user.id, email };
  }

  /** A membership with the organization's Staff role (created here if the org has none yet). */
  join(tenantId: string, userId: string) {
    return this.tenantContext.run({ tenantId, userId }, async () => {
      // Tests join users to the same org in parallel. Prisma doesn't always send the upsert as one
      // INSERT … ON CONFLICT, so the loser of the race reads the winner's role.
      const where = { tenantId_systemKey: { tenantId, systemKey: 'staff' as const } };
      const staff = await this.tenantDb.role
        .upsert({ where, create: { tenantId, systemKey: 'staff' }, update: {} })
        .catch(async (error: unknown) => {
          if ((error as { code?: string }).code !== 'P2002') throw error;
          return this.tenantDb.role.findUniqueOrThrow({ where });
        });
      return this.tenantDb.membership.create({ data: { tenantId, userId, roleId: staff.id } });
    });
  }

  leave(tenantId: string, userId: string) {
    return this.tenantContext.run({ tenantId, userId }, () =>
      this.tenantDb.membership.delete({ where: { tenantId_userId: { tenantId, userId } } }),
    );
  }

  /** Logs in and returns the access token and refresh cookie value. */
  async login(email: string, password = PASSWORD, client = this.client()) {
    const res = await client.post('/login').send({ email, password }).expect(200);
    return {
      res,
      accessToken: (res.body as { accessToken: string }).accessToken,
      refresh: refreshCookieOf(res),
    };
  }

  /** Waits for the background mail to `to` and returns the token from its link. */
  async tokenFromMail(
    to: string,
    page: 'reset-password' | 'verify-email',
    index = -1,
  ): Promise<string> {
    for (let i = 0; i < 100 && this.mailer.to(to).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const mail = this.mailer.to(to).at(index);
    expect(mail, `mail to ${to}`).toBeDefined();
    const match = new RegExp(`${WEB_ORIGIN}/${page}#token=([A-Za-z0-9_-]{43})`).exec(
      mail?.text ?? '',
    );
    expect(match, 'link in mail').not.toBeNull();
    return match?.[1] ?? '';
  }

  /** Lets background work (mails after 202) finish. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function randomIp(): string {
  const b = () => Math.floor(Math.random() * 254) + 1;
  return `10.${b()}.${b()}.${b()}`;
}

/** The refresh cookie set by a response, or undefined. */
export function setCookieHeader(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  return cookies.find((c) => c.startsWith(`${COOKIE}=`));
}

export function refreshCookieOf(res: request.Response): string {
  const header = setCookieHeader(res);
  const value = header?.split(';')[0]?.slice(COOKIE.length + 1);
  expect(value, 'refresh cookie').toBeTruthy();
  return value ?? '';
}

export const cookie = (value: string) => `${COOKIE}=${value}`;
