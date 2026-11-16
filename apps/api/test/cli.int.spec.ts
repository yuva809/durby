import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { createAdmin, DEFAULT_PARTNER } from '../src/cli/create-admin';
import { DEV_PASSWORD, DEV_SEED, DEV_TABLE_SERVICE, seedDev } from '../src/cli/seed-dev';
import { PasswordHasher } from '../src/platform/auth/password-hasher';
import { APP_CONFIG, type AppConfig } from '../src/platform/config';
import { PrismaService } from '../src/platform/database';
import { InMemoryMailer, MAILER } from '../src/platform/mail';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
} from '../src/platform/tenancy';

/** The opt-in local and CI runs have (apps/api/.env.example, ci.yml). */
const DEV_ENV = { NODE_ENV: 'test', DURBY_ALLOW_DEV_SEED: '1' };

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

  /** As tenant `orgId` through the tenant client (RLS applies). */
  const tenantAs = <T>(orgId: string, fn: (db: TenantPrismaClient) => PromiseLike<T>) =>
    app
      .get(TenantContext)
      .run({ tenantId: orgId, userId: uuidv7() }, () =>
        fn(app.get<TenantPrismaClient>(TENANT_PRISMA)),
      );

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
        'waiter',
        'cashier',
        'host',
        'kitchen',
        'bar',
        'branch',
        'warehouse',
        'driver',
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
      await seedDev(app, DEV_ENV);
      await seedDev(app, DEV_ENV);
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

    it('gives the full-plan organizations a location, a menu and tables, once', async () => {
      await seedDev(app, DEV_ENV);
      await seedDev(app, DEV_ENV);
      const products = DEV_TABLE_SERVICE.menu.reduce((n, c) => n + c.products.length, 0);
      for (const seed of DEV_SEED.organizations) {
        const org = await platformDb.organization.findFirstOrThrow({ where: { name: seed.name } });
        const counts = await tenantAs(org.id, async (db) => ({
          locations: await db.location.count(),
          categories: await db.productCategory.count(),
          products: await db.product.count(),
          tables: await db.diningTable.count(),
        }));
        expect(counts).toEqual(
          seed.plan === 'full'
            ? {
                locations: 1,
                categories: DEV_TABLE_SERVICE.menu.length,
                products,
                tables: DEV_TABLE_SERVICE.tables.length,
              }
            : { locations: 0, categories: 0, products: 0, tables: 0 },
        );
        if (seed.plan !== 'full') continue;
        const actors = (await auditOf(org.id))
          .filter((r) => r.action === 'catalog.product.created')
          .map((r) => r.actor);
        expect(new Set(actors)).toEqual(new Set(['cli.seed_dev']));
      }
    });

    it('puts a seeded user back on its declared role and leaves other memberships alone', async () => {
      await seedDev(app, DEV_ENV);
      const staff = await raw.user.findUniqueOrThrow({ where: { email: 'staff@durby.local' } });
      const org = (name: string) => platformDb.organization.findFirstOrThrow({ where: { name } });
      const bistro = await org('Demo Bistro');
      const cafe = await org('Demo Café');
      // Like the 2026-10-22 RBAC backfill, which made every existing membership an Owner.
      await tenantAs(bistro.id, async (db) => {
        const ownerRole = await db.role.findFirstOrThrow({ where: { systemKey: 'owner' } });
        await db.membership.update({
          where: { tenantId_userId: { tenantId: bistro.id, userId: staff.id } },
          data: { roleId: ownerRole.id },
        });
      });
      // A membership the seed doesn't declare (made by hand while testing).
      await tenantAs(cafe.id, async (db) => {
        const manager = await db.role.findFirstOrThrow({ where: { systemKey: 'manager' } });
        await db.membership.upsert({
          where: { tenantId_userId: { tenantId: cafe.id, userId: staff.id } },
          create: { tenantId: cafe.id, userId: staff.id, roleId: manager.id },
          update: { roleId: manager.id },
        });
      });
      expect(await roleOf(staff.id, bistro.id)).toBe('owner');

      await seedDev(app, DEV_ENV);
      await seedDev(app, DEV_ENV);

      expect(await roleOf(staff.id, bistro.id)).toBe('staff');
      expect(await roleOf(staff.id, cafe.id)).toBe('manager');
      const staffRoleId = await tenantAs(
        bistro.id,
        async (db) => (await db.role.findFirstOrThrow({ where: { systemKey: 'staff' } })).id,
      );
      const aligned = (await auditOf(bistro.id)).filter(
        (r) =>
          r.action === 'platform.membership.updated' &&
          (r.after as { roleId?: string } | null)?.roleId === staffRoleId,
      );
      // Once: the second run finds the role already right.
      expect(aligned.map((r) => r.actor)).toEqual(['cli.seed_dev']);
    });

    it('creates the demo staff super admin, active, once', async () => {
      await seedDev(app, DEV_ENV);
      await seedDev(app, DEV_ENV);
      const staff = await app.get(PrismaService).staffAccount.findMany({
        where: { email: { in: DEV_SEED.staff.map((s) => s.email) } },
      });
      expect(staff.map((s) => [s.email, s.role, s.status])).toEqual([
        ['ops@durby.local', 'super_admin', 'active'],
      ]);
      expect(await app.get(PasswordHasher).verify(staff[0]!.passwordHash, DEV_PASSWORD)).toBe(true);
    });

    // Known passwords never reach staging or production (cli/dev-seed-guard.ts).
    it('refuses to run without DURBY_ALLOW_DEV_SEED=1', async () => {
      await expect(seedDev(app, { NODE_ENV: 'test' })).rejects.toThrow(
        /without DURBY_ALLOW_DEV_SEED=1/,
      );
      await expect(
        seedDev(app, { NODE_ENV: 'production', DURBY_ALLOW_DEV_SEED: '1' }),
      ).rejects.toThrow(/NODE_ENV=production/);
    });

    it('refuses to run in production', async () => {
      const config = app.get<AppConfig>(APP_CONFIG);
      const fake = {
        get: (token: unknown): unknown =>
          token === APP_CONFIG
            ? { ...config, NODE_ENV: 'production' }
            : app.get<unknown>(token as never),
      } as unknown as INestApplicationContext;
      await expect(seedDev(fake, DEV_ENV)).rejects.toThrow(
        /refuses to run with NODE_ENV=production/,
      );
    });
  });
});
