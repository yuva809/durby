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

  /** System role key of the user's membership in the org, read as that tenant (RLS). */
  const roleOf = async (userId: string, orgId: string) => {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${orgId}, true)`,
      raw.$queryRaw<{ key: string | null }[]>`
        SELECT r.system_key::text AS key FROM memberships m
        LEFT JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
        WHERE m.user_id = ${userId}::uuid`,
    ]);
    return rows[0]?.key;
  };

  const systemRolesOf = async (orgId: string) => {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${orgId}, true)`,
      raw.$queryRaw<{ key: string }[]>`
        SELECT system_key::text AS key FROM roles WHERE system_key IS NOT NULL ORDER BY system_key`,
    ]);
    return rows.map((r) => r.key);
  };

  /** Memberships of a user across tenants, read as each tenant (RLS) through raw SQL. */
  const membershipCount = async (userId: string, orgId: string) => {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${orgId}, true)`,
      raw.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM memberships WHERE user_id = ${userId}::uuid`,
    ]);
    return rows[0]?.n ?? 0;
  };

  /** Audit rows of the org as [action, actor_system], read as that tenant (RLS). */
  const auditOf = async (orgId: string) => {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${orgId}, true)`,
      raw.$queryRaw<{ action: string; actor: string | null; after: unknown }[]>`
        SELECT action, actor_system AS actor, after FROM audit_logs ORDER BY id`,
    ]);
    return rows;
  };

  describe('create-admin', () => {
    // ADR 0015 §3: the demo partner comes from the partner_theming migration.
    it('creates the organization under an existing partner with --partner', async () => {
      const demo = await platformDb.partner.findUniqueOrThrow({ where: { slug: 'demo' } });
      const org = `Org ${uuidv7()}`;
      const result = await createAdmin(app, {
        email: `admin-${uuidv7()}@example.test`,
        org,
        locale: 'en',
        plan: 'inventory',
        partner: 'demo',
      });
      expect(result.partner).toEqual({ id: demo.id, created: false });
      expect(
        await platformDb.organization.findUniqueOrThrow({ where: { id: result.organization.id } }),
      ).toMatchObject({ partnerId: demo.id, name: org });
    });

    it('refuses an unknown partner instead of creating it', async () => {
      await expect(
        createAdmin(app, {
          email: `admin-${uuidv7()}@example.test`,
          org: `Org ${uuidv7()}`,
          locale: 'en',
          plan: 'full',
          partner: 'nope',
        }),
      ).rejects.toThrow(/Partner "nope" does not exist/);
      expect(await platformDb.partner.count({ where: { slug: 'nope' } })).toBe(0);
    });

    it('creates partner, organization, user and membership once, and mails a password link', async () => {
      const email = `admin-${uuidv7()}@example.test`;
      const org = `Org ${uuidv7()}`;

      const first = await createAdmin(app, { email, org, locale: 'de', plan: 'full' });
      expect(first.organization.created).toBe(true);
      expect(first.user.created).toBe(true);
      expect(first.membership.created).toBe(true);

      const second = await createAdmin(app, { email, org, locale: 'de', plan: 'full' });
      expect(second).toEqual({
        partner: { id: first.partner.id, created: false },
        organization: { id: first.organization.id, created: false },
        user: { id: first.user.id, created: false },
        membership: { id: first.membership.id, created: false },
      });

      expect(await platformDb.organization.count({ where: { name: org } })).toBe(1);
      expect(await raw.user.count({ where: { email } })).toBe(1);
      expect(await membershipCount(first.user.id, first.organization.id)).toBe(1);
      expect(await systemRolesOf(first.organization.id)).toEqual([
        'owner',
        'admin',
        'manager',
        'staff',
      ]);
      expect(await roleOf(first.user.id, first.organization.id)).toBe('owner');
      // Audited once with the command as actor; the second run changed nothing and wrote nothing.
      expect((await auditOf(first.organization.id)).map((r) => [r.action, r.actor])).toEqual([
        ['platform.organization.created', 'cli.create_admin'],
        ['platform.membership.created', 'cli.create_admin'],
      ]);

      const user = await raw.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({
        passwordHash: null,
        emailVerifiedAt: null,
        locale: 'de',
      });

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
      const a = await createAdmin(app, { email, org: `A ${uuidv7()}`, locale: 'en', plan: 'full' });
      const hash = await app.get(PasswordHasher).hash('existing password!');
      await raw.user.update({ where: { id: a.user.id }, data: { passwordHash: hash } });

      const b = await createAdmin(app, { email, org: `B ${uuidv7()}`, locale: 'de', plan: 'full' });
      expect(b.user).toEqual({ id: a.user.id, created: false });
      expect(b.organization.created).toBe(true);
      const user = await raw.user.findUniqueOrThrow({ where: { id: a.user.id } });
      expect(user).toMatchObject({ passwordHash: hash, locale: 'en' });
    });

    it('puts a new organization on --plan, audited with it; an existing one keeps its plan', async () => {
      const org = `Planned ${uuidv7()}`;
      const email = `admin-${uuidv7()}@example.test`;
      const first = await createAdmin(app, { email, org, locale: 'en', plan: 'inventory' });
      const planOf = async () =>
        (
          await platformDb.organization.findUniqueOrThrow({
            where: { id: first.organization.id },
            select: { plan: { select: { id: true, key: true } } },
          })
        ).plan;
      const plan = await planOf();
      expect(plan?.key).toBe('inventory');
      expect((await auditOf(first.organization.id))[0]).toMatchObject({
        action: 'platform.organization.created',
        after: { id: first.organization.id, planId: plan?.id },
      });

      await createAdmin(app, { email, org, locale: 'en', plan: 'full' });
      expect((await planOf())?.key).toBe('inventory');
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
      const demoUsers = () => raw.user.count({ where: { email: { endsWith: '@durby.local' } } });
      const before = await namesUnderDefaultPartner();
      const demoBefore = await demoUsers();
      const org = `Only ${uuidv7()}`;
      await createAdmin(app, {
        email: `admin-${uuidv7()}@example.test`,
        org,
        locale: 'en',
        plan: 'full',
      });
      const added = (await namesUnderDefaultPartner()).filter((name) => !before.includes(name));
      // Other tests (seed-dev) may add demo organizations in parallel, never under this name.
      expect(added.filter((name) => name.startsWith('Demo '))).toEqual([]);
      expect(added).toContain(org);
      expect(await demoUsers()).toBe(demoBefore);
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
          expect(await roleOf(user.id, orgs[0]?.id ?? '')).toBe(seed.role);
        }
      }
      for (const seed of DEV_SEED.organizations) {
        const org = await platformDb.organization.findFirstOrThrow({
          where: { name: seed.name },
          include: { partner: true, plan: true },
        });
        // Two-domain demo (docs/platform/web-shell.md): partner and plan per organization.
        expect([org.partner.slug, org.plan?.key]).toEqual([seed.partner, seed.plan]);
        const created = (await auditOf(org.id)).filter(
          (r) => r.action === 'platform.organization.created',
        );
        expect(created.map((r) => r.actor)).toEqual(['cli.seed_dev']);
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
