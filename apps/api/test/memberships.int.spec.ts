import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/platform/config';
import { DatabaseModule, PrismaService } from '../src/platform/database';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenancyModule,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../src/platform/tenancy';
import { planIdOf } from './support/plans';

// Memberships are a tenant table (ADR 0005), and auth_user_organization_ids() is the one way to
// list a user's organizations across tenants (ADR 0006). Everything runs as durby_app; each test
// creates its own users and organizations.

const RLS_VIOLATION = /row-level security/i;

describe('memberships', () => {
  let moduleRef: TestingModule;
  let raw: PrismaService;
  let tenantDb: TenantPrismaClient;
  let platformDb: PlatformPrismaClient;
  let context: TenantContext;
  let partnerId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, TenancyModule],
    }).compile();
    await moduleRef.init();
    raw = moduleRef.get(PrismaService);
    tenantDb = moduleRef.get(TENANT_PRISMA);
    platformDb = moduleRef.get(PLATFORM_PRISMA);
    context = moduleRef.get(TenantContext);
    partnerId = (
      await platformDb.partner.create({ data: { slug: `test-${uuidv7()}`, name: 'Test partner' } })
    ).id;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  // Users are auth-private; tests create them with the raw client, as platform/auth will.
  const createUser = async (): Promise<string> =>
    (await raw.user.create({ data: { email: `${uuidv7()}@example.test` } })).id;

  const createOrg = async (name: string): Promise<string> =>
    (
      await platformDb.organization.create({
        data: { partnerId, name, planId: await planIdOf(platformDb) },
      })
    ).id;

  /** A membership with the org's Staff role (role_id is NOT NULL). */
  const join = (tenantId: string, userId: string) =>
    context.run({ tenantId, userId }, async () => {
      const staff =
        (await tenantDb.role.findFirst({ where: { systemKey: 'staff' } })) ??
        (await tenantDb.role.create({ data: { tenantId, systemKey: 'staff' } }));
      return tenantDb.membership.create({ data: { tenantId, userId, roleId: staff.id } });
    });

  /** What platform/auth will do: app.user_id set from the verified token, same transaction. */
  async function organizationsOf(userId: string | null): Promise<string[]> {
    const [, rows] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.user_id', ${userId ?? ''}, true)`,
      raw.$queryRaw<{ organization_id: string }[]>`
        SELECT organization_id FROM auth_user_organization_ids() ORDER BY organization_id`,
    ]);
    return rows.map((r) => r.organization_id);
  }

  describe('tenant isolation', () => {
    it('tenant A cannot read tenant B memberships', async () => {
      const [orgA, orgB, user] = await Promise.all([createOrg('A'), createOrg('B'), createUser()]);
      const [, mB] = await Promise.all([join(orgA, user), join(orgB, user)]);

      await context.run({ tenantId: orgA, userId: user }, async () => {
        const all = await tenantDb.membership.findMany({ where: { userId: user } });
        expect(all.map((m) => m.tenantId)).toEqual([orgA]);
        expect(await tenantDb.membership.findUnique({ where: { id: mB.id } })).toBeNull();
        const viaRaw = await tenantDb.$queryRaw<{ tenant_id: string }[]>`
          SELECT tenant_id FROM memberships WHERE user_id = ${user}::uuid`;
        expect(viaRaw.map((r) => r.tenant_id)).toEqual([orgA]);
      });
    });

    it('tenant A cannot create, move or delete tenant B memberships', async () => {
      const [orgA, orgB, user] = await Promise.all([createOrg('A'), createOrg('B'), createUser()]);
      const mA = await join(orgA, user);
      const mB = await join(orgB, await createUser());

      await context.run({ tenantId: orgA, userId: user }, async () => {
        await expect(
          tenantDb.membership.create({ data: { tenantId: orgB, userId: user, roleId: mA.roleId } }),
        ).rejects.toThrow(RLS_VIOLATION);
        await expect(
          tenantDb.membership.update({ where: { id: mA.id }, data: { tenantId: orgB } }),
        ).rejects.toThrow(RLS_VIOLATION);
        expect(await tenantDb.membership.deleteMany({ where: { id: mB.id } })).toEqual({
          count: 0,
        });
      });
      await context.run({ tenantId: orgB, userId: user }, async () => {
        expect(await tenantDb.membership.findUnique({ where: { id: mB.id } })).not.toBeNull();
      });
    });

    it('the raw app client sees no memberships without a tenant (fail closed)', async () => {
      const [org, user] = await Promise.all([createOrg('A'), createUser()]);
      await join(org, user);
      expect(await raw.membership.count({ where: { userId: user } })).toBe(0);
    });

    it('a membership is unique per tenant and user', async () => {
      const [org, user] = await Promise.all([createOrg('A'), createUser()]);
      await join(org, user);
      await expect(join(org, user)).rejects.toThrow(/unique/i);
    });
  });

  describe('auth_user_organization_ids()', () => {
    it("returns all of the user's organizations across tenants, and only theirs", async () => {
      const [orgA, orgB, orgC, user, other] = await Promise.all([
        createOrg('A'),
        createOrg('B'),
        createOrg('C'),
        createUser(),
        createUser(),
      ]);
      await Promise.all([join(orgA, user), join(orgB, user), join(orgC, other)]);

      expect(await organizationsOf(user)).toEqual([orgA, orgB].sort());
      expect(await organizationsOf(other)).toEqual([orgC]);
    });

    it('returns nothing when app.user_id is unset or empty', async () => {
      const [org, user] = await Promise.all([createOrg('A'), createUser()]);
      await join(org, user);

      expect(await organizationsOf(null)).toEqual([]);
      const unset = await raw.$queryRaw<{ organization_id: string }[]>`
        SELECT organization_id FROM auth_user_organization_ids()`;
      expect(unset).toEqual([]);
    });

    it('returns nothing for a user without memberships', async () => {
      expect(await organizationsOf(await createUser())).toEqual([]);
    });

    it('takes no parameter: a caller cannot ask for another user', async () => {
      await expect(
        raw.$queryRaw`SELECT * FROM auth_user_organization_ids(${uuidv7()}::uuid)`,
      ).rejects.toThrow(/does not exist/i);
    });

    it('app.user_id does not leak back into the connection pool', async () => {
      const [org, user] = await Promise.all([createOrg('A'), createUser()]);
      await join(org, user);
      await Promise.all(Array.from({ length: 20 }, () => organizationsOf(user)));

      const results = await Promise.all(
        Array.from(
          { length: 20 },
          () => raw.$queryRaw<{ organization_id: string }[]>`
            SELECT organization_id FROM auth_user_organization_ids()`,
        ),
      );
      for (const rows of results) expect(rows).toEqual([]);
    });

    it('durby_app still cannot read memberships directly', async () => {
      const [org, user] = await Promise.all([createOrg('A'), createUser()]);
      await join(org, user);
      const [, rows] = await raw.$transaction([
        raw.$executeRaw`SELECT set_config('app.user_id', ${user}, true)`,
        raw.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM memberships`,
      ]);
      expect(rows[0]?.n).toBe(0);
    });
  });
});
