import type { INestApplication } from '@nestjs/common';
import { SYSTEM_ROLES, type SystemRole } from '@durby/shared';
import { v7 as uuidv7 } from 'uuid';
import { AccessTokenService } from '../../src/platform/auth/access-token.service';
import { PrismaService } from '../../src/platform/database';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../../src/platform/tenancy';

export interface SeededOrg {
  id: string;
  roles: Record<SystemRole, string>;
  locations: [string, string];
}

/** Test data for RBAC: organizations with system roles and locations, users, memberships. */
export class RbacSeed {
  private readonly platform: PlatformPrismaClient;
  private readonly tenant: TenantPrismaClient;
  private readonly context: TenantContext;
  private readonly raw: PrismaService;
  private readonly tokens: AccessTokenService;

  constructor(app: INestApplication) {
    this.platform = app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
    this.tenant = app.get<TenantPrismaClient>(TENANT_PRISMA);
    this.context = app.get(TenantContext);
    this.raw = app.get(PrismaService);
    this.tokens = app.get(AccessTokenService);
  }

  /** As tenant `orgId` (RLS applies), like a request of that organization. */
  as<T>(orgId: string, fn: (db: TenantPrismaClient) => PromiseLike<T>): Promise<T> {
    return this.context.run({ tenantId: orgId, userId: uuidv7() }, () => fn(this.tenant));
  }

  /** An organization on its own new partner, or on `opts.partnerId` (e.g. the demo partner). */
  async org(name = 'Org', opts: { partnerId?: string } = {}): Promise<SeededOrg> {
    const partnerId =
      opts.partnerId ??
      (await this.platform.partner.create({ data: { slug: `p-${uuidv7()}`, name: 'P' } })).id;
    const org = await this.platform.organization.create({ data: { partnerId, name } });
    return this.as(org.id, async (db) => {
      const roles = {} as Record<SystemRole, string>;
      for (const systemKey of SYSTEM_ROLES) {
        roles[systemKey] = (await db.role.create({ data: { tenantId: org.id, systemKey } })).id;
      }
      const brand = await db.brand.create({ data: { tenantId: org.id, name: 'B' } });
      const locations = (await Promise.all(
        ['L1', 'L2'].map(
          async (n) =>
            (await db.location.create({ data: { tenantId: org.id, brandId: brand.id, name: n } }))
              .id,
        ),
      )) as [string, string];
      return { id: org.id, roles, locations };
    });
  }

  async customRole(orgId: string, permissions: string[], name = `R-${uuidv7()}`): Promise<string> {
    return this.as(orgId, async (db) => {
      const role = await db.role.create({ data: { tenantId: orgId, name } });
      await db.rolePermission.createMany({
        data: permissions.map((permissionKey) => ({
          tenantId: orgId,
          roleId: role.id,
          permissionKey,
        })),
      });
      return role.id;
    });
  }

  async user(email = `u-${uuidv7()}@durby.test`): Promise<string> {
    return (await this.raw.user.create({ data: { email, emailVerifiedAt: new Date() } })).id;
  }

  async member(
    orgId: string,
    userId: string,
    roleId: string | null,
    opts: { locations?: string[] } = {},
  ): Promise<string> {
    return this.as(orgId, async (db) => {
      const m = await db.membership.create({
        data: { tenantId: orgId, userId, roleId, allLocations: opts.locations === undefined },
      });
      await db.membershipLocation.createMany({
        data: (opts.locations ?? []).map((locationId) => ({
          tenantId: orgId,
          membershipId: m.id,
          locationId,
        })),
      });
      return m.id;
    });
  }

  token(userId: string, organizationId: string | null): Promise<string> {
    return this.tokens.sign({ userId, organizationId, sessionId: uuidv7() });
  }
}
