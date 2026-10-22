import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { createAdmin, DEFAULT_PARTNER } from '../src/cli/create-admin';
import { DEV_PASSWORD, DEV_SEED, seedDev } from '../src/cli/seed-dev';
import { PasswordHasher } from '../src/platform/auth/password-hasher';
import { APP_CONFIG, type AppConfig } from '../src/platform/config';
import { PrismaService } from '../src/platform/database';
import { InMemoryMailer, MAILER } from '../src/platform/mail';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';

describe('bootstrap commands', () => {
  let app: INestApplicationContext;
  let raw: PrismaService;
  let platformDb: PlatformPrismaClient;
  const mailer = new InMemoryMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = await moduleRef.init();
    raw = app.get(PrismaService);
    platformDb = app.get(PLATFORM_PRISMA);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Memberships of a user across tenants, read as each tenant (RLS) through raw SQL. */
  const membershipCount = async (userId: string, orgId: string) => {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${orgId}, true)`,
      raw.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM memberships WHERE user_id = ${userId}::uuid`,
    ]);
    return rows[0]?.n ?? 0;
  };

  describe('create-admin', () => {
    it('creates partner, organization, user and membership once, and mails a password link', async () => {
      const email = `admin-${uuidv7()}@example.test`;
      const org = `Org ${uuidv7()}`;

      const first = await createAdmin(app, { email, org, locale: 'de' });
      expect(first.organization.created).toBe(true);
      expect(first.user.created).toBe(true);
      expect(first.membership.created).toBe(true);

      const second = await createAdmin(app, { email, org, locale: 'de' });
      expect(second).toEqual({
        partner: { id: first.partner.id, created: false },
        organization: { id: first.organization.id, created: false },
        user: { id: first.user.id, created: false },
        membership: { id: first.membership.id, created: false },
      });

      expect(await platformDb.organization.count({ where: { name: org } })).toBe(1);
      expect(await raw.user.count({ where: { email } })).toBe(1);
      expect(await membershipCount(first.user.id, first.organization.id)).toBe(1);

      const user = await raw.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({ passwordHash: null, emailVerifiedAt: null, locale: 'de' });

      // A fresh link each run; only the newest works.
      const mails = mailer.to(email);
      expect(mails).toHaveLength(2);
      expect(mails[1]?.text).toMatch(/\/reset-password#token=[A-Za-z0-9_-]{43}/);
      const openTokens = await raw.userToken.count({
        where: { userId: user.id, purpose: 'password_reset', usedAt: null },
      });
      expect(openTokens).toBe(1);
    });

    it('adds an existing user to a new organization without touching their account', async () => {
      const email = `admin-${uuidv7()}@example.test`;
      const a = await createAdmin(app, { email, org: `A ${uuidv7()}`, locale: 'en' });
      const hash = await app.get(PasswordHasher).hash('existing password!');
      await raw.user.update({ where: { id: a.user.id }, data: { passwordHash: hash } });

      const b = await createAdmin(app, { email, org: `B ${uuidv7()}`, locale: 'de' });
      expect(b.user).toEqual({ id: a.user.id, created: false });
      expect(b.organization.created).toBe(true);
      const user = await raw.user.findUniqueOrThrow({ where: { id: a.user.id } });
      expect(user).toMatchObject({ passwordHash: hash, locale: 'en' });
    });

    it('creates no demo data', async () => {
      // Scoped to the default partner: other test files create organizations in parallel.
      const namesUnderDefaultPartner = async () =>
        (
          await platformDb.organization.findMany({
            where: { partner: { slug: DEFAULT_PARTNER.slug } },
            select: { name: true },
          })
        ).map((o) => o.name);
      const before = await namesUnderDefaultPartner();
      const org = `Only ${uuidv7()}`;
      await createAdmin(app, { email: `admin-${uuidv7()}@example.test`, org, locale: 'en' });
      const added = (await namesUnderDefaultPartner()).filter((name) => !before.includes(name));
      expect(added).toEqual([org]);
      expect(await raw.user.count({ where: { email: { endsWith: '@durby.local' } } })).toBe(0);
    });
  });

  describe('seed-dev', () => {
    it('creates the demo organizations and users with a working password, idempotently', async () => {
      await seedDev(app);
      await seedDev(app);
      for (const seed of DEV_SEED.users) {
        const user = await raw.user.findUniqueOrThrow({ where: { email: seed.email } });
        expect(user.emailVerifiedAt).not.toBeNull();
        expect(await app.get(PasswordHasher).verify(user.passwordHash, DEV_PASSWORD)).toBe(true);
        for (const name of seed.organizations) {
          const orgs = await platformDb.organization.findMany({ where: { name } });
          expect(orgs).toHaveLength(1);
          expect(await membershipCount(user.id, orgs[0]?.id ?? '')).toBe(1);
        }
      }
      // Cleanup so the create-admin "no demo data" test stays order-independent.
      for (const seed of DEV_SEED.users) {
        const user = await raw.user.findUniqueOrThrow({ where: { email: seed.email } });
        for (const name of seed.organizations) {
          const org = await platformDb.organization.findFirstOrThrow({ where: { name } });
          await raw.$transaction([
            raw.$executeRaw`SELECT set_config('app.tenant_id', ${org.id}, true)`,
            raw.$executeRaw`DELETE FROM memberships WHERE user_id = ${user.id}::uuid`,
          ]);
        }
        await raw.user.delete({ where: { id: user.id } });
      }
    });

    it('refuses to run in production', async () => {
      const config = app.get<AppConfig>(APP_CONFIG);
      const fake = {
        get: (token: unknown): unknown =>
          token === APP_CONFIG
            ? { ...config, NODE_ENV: 'production' }
            : app.get<unknown>(token as never),
      } as unknown as INestApplicationContext;
      await expect(seedDev(fake)).rejects.toThrow(/refuses to run with NODE_ENV=production/);
    });
  });
});
