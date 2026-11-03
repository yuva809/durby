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

// The Manage Staff tables and rules in the database (ADR 0023): per-member overrides are tenant
// data under RLS, and the last *active* Owner can't be deactivated. Everything runs as durby_app.

const RLS_VIOLATION = /row-level security/i;
const LAST_OWNER = /would have no owner|memberships_keep_last_owner/i;

describe('manage staff (database)', () => {
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

  const createUser = async (): Promise<string> =>
    (await raw.user.create({ data: { email: `${uuidv7()}@example.test` } })).id;

  const createOrg = async (): Promise<string> =>
    (
      await platformDb.organization.create({
        data: { partnerId, name: 'Org', planId: await planIdOf(platformDb) },
      })
    ).id;

  const join = (tenantId: string, userId: string, systemKey: 'owner' | 'staff') =>
    context.run({ tenantId, userId }, async () => {
      const role =
        (await tenantDb.role.findFirst({ where: { systemKey } })) ??
        (await tenantDb.role.create({ data: { tenantId, systemKey } }));
      return tenantDb.membership.create({ data: { tenantId, userId, roleId: role.id } });
    });

  it('keeps per-member overrides inside their tenant', async () => {
    const [orgA, orgB, user] = await Promise.all([createOrg(), createOrg(), createUser()]);
    const [mA, mB] = await Promise.all([join(orgA, user, 'staff'), join(orgB, user, 'staff')]);
    await context.run({ tenantId: orgB, userId: user }, () =>
      tenantDb.membershipPermission.create({
        data: {
          tenantId: orgB,
          membershipId: mB.id,
          permissionKey: 'pos.bills.print',
          effect: 'grant',
        },
      }),
    );

    await context.run({ tenantId: orgA, userId: user }, async () => {
      expect(await tenantDb.membershipPermission.count()).toBe(0);
      await expect(
        tenantDb.membershipPermission.create({
          data: {
            tenantId: orgB,
            membershipId: mB.id,
            permissionKey: 'pos.orders.read',
            effect: 'grant',
          },
        }),
      ).rejects.toThrow(RLS_VIOLATION);
      // The composite FK: an override of tenant A can't point at tenant B's membership.
      await expect(
        tenantDb.membershipPermission.create({
          data: {
            tenantId: orgA,
            membershipId: mB.id,
            permissionKey: 'pos.orders.read',
            effect: 'deny',
          },
        }),
      ).rejects.toThrow();
      await tenantDb.membershipPermission.create({
        data: {
          tenantId: orgA,
          membershipId: mA.id,
          permissionKey: 'pos.orders.read',
          effect: 'deny',
        },
      });
      expect(await tenantDb.membershipPermission.count()).toBe(1);
    });
    expect(await raw.membershipPermission.count({ where: { membershipId: mB.id } })).toBe(0);
  });

  it('checks the key shape and one override per key', async () => {
    const [org, user] = await Promise.all([createOrg(), createUser()]);
    const m = await join(org, user, 'staff');
    await context.run({ tenantId: org, userId: user }, async () => {
      await expect(
        tenantDb.membershipPermission.create({
          data: { tenantId: org, membershipId: m.id, permissionKey: 'Not A Key', effect: 'grant' },
        }),
      ).rejects.toThrow(/check/i);
      await tenantDb.membershipPermission.create({
        data: {
          tenantId: org,
          membershipId: m.id,
          permissionKey: 'pos.bills.print',
          effect: 'grant',
        },
      });
      await expect(
        tenantDb.membershipPermission.create({
          data: {
            tenantId: org,
            membershipId: m.id,
            permissionKey: 'pos.bills.print',
            effect: 'deny',
          },
        }),
      ).rejects.toThrow(/unique/i);
    });
  });

  it('never deactivates the last active Owner, but one of two', async () => {
    const [org, a, b] = await Promise.all([createOrg(), createUser(), createUser()]);
    const ownerA = await join(org, a, 'owner');

    await expect(
      context.run({ tenantId: org, userId: a }, () =>
        tenantDb.membership.update({
          where: { id: ownerA.id },
          data: { deactivatedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(LAST_OWNER);

    const ownerB = await join(org, b, 'owner');
    await context.run({ tenantId: org, userId: a }, () =>
      tenantDb.membership.update({ where: { id: ownerB.id }, data: { deactivatedAt: new Date() } }),
    );
    // B is inactive now: A is the last active Owner again.
    await expect(
      context.run({ tenantId: org, userId: a }, () =>
        tenantDb.membership.update({
          where: { id: ownerA.id },
          data: { deactivatedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(LAST_OWNER);
  });

  it('keeps names and phones trimmed', async () => {
    const [org, user] = await Promise.all([createOrg(), createUser()]);
    const m = await join(org, user, 'staff');
    await context.run({ tenantId: org, userId: user }, async () => {
      await expect(
        tenantDb.membership.update({ where: { id: m.id }, data: { displayName: ' Ravi ' } }),
      ).rejects.toThrow(/check/i);
      await tenantDb.membership.update({
        where: { id: m.id },
        data: { displayName: 'Ravi', phone: '+49 151 1234567' },
      });
    });
  });
});
