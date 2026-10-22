import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/platform/config';
import { DatabaseModule, PrismaService } from '../src/platform/database';
import {
  AuthPrivateModelOnPlatformClientError,
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenancyModule,
  TenantContext,
  TenantContextMissingError,
  TenantModelOnPlatformClientError,
  type PlatformPrismaClient,
  type TenantContextValue,
  type TenantPrismaClient,
} from '../src/platform/tenancy';

// Tenant isolation (ADR 0005). All clients connect as durby_app (DATABASE_URL). The database is
// shared per run, so every test creates its own tenants with fresh UUIDv7 ids and never relies
// on rows from other tests.

interface SeededTenant {
  ctx: TenantContextValue;
  brandId: string;
  locationId: string;
}

const RLS_VIOLATION = /row-level security/i;

describe('tenant isolation', () => {
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

    const partner = await platformDb.partner.create({
      data: { slug: `test-${uuidv7()}`, name: 'Test partner' },
    });
    partnerId = partner.id;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function seedTenant(label: string): Promise<SeededTenant> {
    const org = await platformDb.organization.create({ data: { partnerId, name: label } });
    const ctx = { tenantId: org.id, userId: uuidv7() };
    return context.run(ctx, async () => {
      const brand = await tenantDb.brand.create({
        data: { tenantId: org.id, name: `${label} brand` },
      });
      const location = await tenantDb.location.create({
        data: { tenantId: org.id, brandId: brand.id, name: `${label} location` },
      });
      return { ctx, brandId: brand.id, locationId: location.id };
    });
  }

  async function twoTenants(): Promise<[SeededTenant, SeededTenant]> {
    return Promise.all([seedTenant('A'), seedTenant('B')]);
  }

  /** B's rows, read as B, must be exactly as seeded. */
  async function expectUntouched(b: SeededTenant): Promise<void> {
    await context.run(b.ctx, async () => {
      expect(await tenantDb.brand.findUnique({ where: { id: b.brandId } })).toMatchObject({
        tenantId: b.ctx.tenantId,
        name: 'B brand',
      });
      expect(await tenantDb.location.findUnique({ where: { id: b.locationId } })).toMatchObject({
        tenantId: b.ctx.tenantId,
        brandId: b.brandId,
        name: 'B location',
      });
    });
  }

  it('runs as durby_app with the tenant set inside the transaction', async () => {
    const [a] = await twoTenants();
    const [row] = await context.run(
      a.ctx,
      () =>
        tenantDb.$queryRaw<{ role: string; tenant: string }[]>`
        SELECT current_user AS role, current_setting('app.tenant_id', true) AS tenant`,
    );
    expect(row).toEqual({ role: 'durby_app', tenant: a.ctx.tenantId });
  });

  describe('tenant A cannot read tenant B', () => {
    it('via model calls', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        expect((await tenantDb.brand.findMany()).map((r) => r.id)).toEqual([a.brandId]);
        expect((await tenantDb.location.findMany()).map((r) => r.id)).toEqual([a.locationId]);
        expect(await tenantDb.brand.findUnique({ where: { id: b.brandId } })).toBeNull();
        expect(
          await tenantDb.location.findFirst({ where: { tenantId: b.ctx.tenantId } }),
        ).toBeNull();
        expect(await tenantDb.brand.count({ where: { tenantId: b.ctx.tenantId } })).toBe(0);
      });
    });

    it('via raw queries through the app client', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        const brands = await tenantDb.$queryRaw<{ id: string }[]>`SELECT id FROM brands`;
        expect(brands.map((r) => r.id)).toEqual([a.brandId]);
        const targeted = await tenantDb.$queryRaw<{ id: string }[]>`
          SELECT id FROM locations WHERE tenant_id = ${b.ctx.tenantId}::uuid OR id = ${b.locationId}::uuid`;
        expect(targeted).toEqual([]);
      });
    });
  });

  describe('tenant A cannot update tenant B', () => {
    it('via model calls', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        await expect(
          tenantDb.brand.update({ where: { id: b.brandId }, data: { name: 'hacked' } }),
        ).rejects.toMatchObject({ code: 'P2025' });
        expect(
          await tenantDb.location.updateMany({
            where: { tenantId: b.ctx.tenantId },
            data: { name: 'hacked' },
          }),
        ).toEqual({ count: 0 });
      });
      await expectUntouched(b);
    });

    it('via raw queries through the app client', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        expect(await tenantDb.$executeRaw`UPDATE brands SET name = 'hacked'`).toBe(1); // only A's own row
        expect(
          await tenantDb.$executeRaw`UPDATE locations SET name = 'hacked' WHERE id = ${b.locationId}::uuid`,
        ).toBe(0);
      });
      await expectUntouched(b);
    });
  });

  describe('tenant A cannot delete tenant B', () => {
    it('via model calls', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        await expect(
          tenantDb.location.delete({ where: { id: b.locationId } }),
        ).rejects.toMatchObject({
          code: 'P2025',
        });
        expect(await tenantDb.location.deleteMany({ where: { tenantId: b.ctx.tenantId } })).toEqual(
          {
            count: 0,
          },
        );
      });
      await expectUntouched(b);
    });

    it('via raw queries through the app client', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        expect(
          await tenantDb.$executeRaw`DELETE FROM locations WHERE id = ${b.locationId}::uuid`,
        ).toBe(0);
        expect(
          await tenantDb.$executeRaw`DELETE FROM locations WHERE tenant_id <> ${a.ctx.tenantId}::uuid`,
        ).toBe(0);
      });
      await expectUntouched(b);
    });
  });

  describe('tenant A cannot write rows into tenant B', () => {
    it('rejects inserts carrying another tenant_id', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        await expect(
          tenantDb.brand.create({ data: { tenantId: b.ctx.tenantId, name: 'planted' } }),
        ).rejects.toThrow(RLS_VIOLATION);
        await expect(
          tenantDb.$executeRaw`INSERT INTO brands (tenant_id, name, updated_at)
                               VALUES (${b.ctx.tenantId}::uuid, 'planted', now())`,
        ).rejects.toThrow(RLS_VIOLATION);
      });
      await context.run(b.ctx, async () => {
        expect(await tenantDb.brand.count()).toBe(1);
      });
    });

    it('rejects moving an own row to another tenant', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        await expect(
          tenantDb.$executeRaw`UPDATE locations SET tenant_id = ${b.ctx.tenantId}::uuid WHERE id = ${a.locationId}::uuid`,
        ).rejects.toThrow(RLS_VIOLATION);
      });
    });

    it('rejects references to another tenant’s rows (composite tenant FK)', async () => {
      const [a, b] = await twoTenants();
      await context.run(a.ctx, async () => {
        await expect(
          tenantDb.location.create({
            data: { tenantId: a.ctx.tenantId, brandId: b.brandId, name: 'x' },
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });
  });

  describe('missing tenant context', () => {
    it('the tenant client throws for model calls, raw queries and transactions', async () => {
      await expect(tenantDb.brand.findMany()).rejects.toThrow(TenantContextMissingError);
      await expect(tenantDb.$queryRaw`SELECT id FROM brands`).rejects.toThrow(
        TenantContextMissingError,
      );
      await expect(tenantDb.$executeRaw`DELETE FROM brands`).rejects.toThrow(
        TenantContextMissingError,
      );
      await expect(tenantDb.$transaction(async (tx) => tx.brand.findMany())).rejects.toThrow(
        TenantContextMissingError,
      );
    });

    it('the raw app client sees no tenant rows and cannot write any (fail closed)', async () => {
      const [a] = await twoTenants();
      expect(await raw.brand.findUnique({ where: { id: a.brandId } })).toBeNull();
      expect(
        await raw.$queryRaw`SELECT id FROM locations WHERE id = ${a.locationId}::uuid`,
      ).toEqual([]);
      expect(await raw.$executeRaw`DELETE FROM brands WHERE id = ${a.brandId}::uuid`).toBe(0);
      await expect(
        raw.brand.create({ data: { tenantId: a.ctx.tenantId, name: 'no context' } }),
      ).rejects.toThrow(RLS_VIOLATION);
    });

    it('the platform client refuses tenant models', async () => {
      const [a] = await twoTenants();
      await expect(platformDb.brand.findMany()).rejects.toThrow(TenantModelOnPlatformClientError);
      // Even inside a tenant context: tenant tables go through the tenant client only.
      await context.run(a.ctx, async () => {
        await expect(platformDb.location.count()).rejects.toThrow(TenantModelOnPlatformClientError);
      });
    });

    it('the platform client refuses auth-private models (users, tokens)', async () => {
      await expect(platformDb.user.findMany()).rejects.toThrow(
        AuthPrivateModelOnPlatformClientError,
      );
      await expect(platformDb.userToken.count()).rejects.toThrow(
        AuthPrivateModelOnPlatformClientError,
      );
      await expect(platformDb.refreshToken.findFirst()).rejects.toThrow(
        AuthPrivateModelOnPlatformClientError,
      );
    });
  });

  it('the tenant setting does not leak back into the connection pool', async () => {
    const [a, b] = await twoTenants();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        context.run(i % 2 ? a.ctx : b.ctx, () => tenantDb.brand.count()),
      ),
    );
    const settings = await Promise.all(
      Array.from(
        { length: 20 },
        () =>
          raw.$queryRaw<
            { tenant: string | null }[]
          >`SELECT current_setting('app.tenant_id', true) AS tenant`,
      ),
    );
    for (const [row] of settings) expect(row?.tenant ?? '').toBe('');
  });

  it('parallel requests of different tenants stay isolated', async () => {
    const [a, b] = await twoTenants();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const t = i % 2 ? a : b;
        return context.run(t.ctx, async () => ({
          expected: t.brandId,
          seen: (await tenantDb.brand.findMany()).map((r) => r.id),
        }));
      }),
    );
    for (const { expected, seen } of results) expect(seen).toEqual([expected]);
  });

  describe('$transaction(fn)', () => {
    it('runs all statements in one transaction scoped to the tenant', async () => {
      const [a, b] = await twoTenants();
      const seen = await context.run(a.ctx, () =>
        tenantDb.$transaction(async (tx) => {
          const [ids] = await Promise.all([
            tx.$queryRaw<{ id: string }[]>`SELECT id FROM brands`,
            tx.brand.update({ where: { id: a.brandId }, data: { name: 'A renamed' } }),
          ]);
          const others = await tx.location.findMany({ where: { id: b.locationId } });
          return { ids: ids.map((r) => r.id), others };
        }),
      );
      expect(seen).toEqual({ ids: [a.brandId], others: [] });
    });

    it('rolls back every statement when fn throws', async () => {
      const [a] = await twoTenants();
      await context.run(a.ctx, async () => {
        await expect(
          tenantDb.$transaction(async (tx) => {
            await tx.brand.create({ data: { tenantId: a.ctx.tenantId, name: 'rolled back' } });
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await tenantDb.brand.count({ where: { name: 'rolled back' } })).toBe(0);
      });
    });
  });
});
