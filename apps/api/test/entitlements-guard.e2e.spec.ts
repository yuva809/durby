import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  EntitlementsAdmin,
  EntitlementService,
  RequireFeature,
} from '../src/platform/config/entitlements';
import { RequirePermission } from '../src/platform/rbac';
import { TenantContext } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { emptyPlanFor } from './support/plans';

/** Test-only routes: an "inventory module" that doesn't exist yet. Never shipped. */
@RequireFeature('inventory')
@Controller('entitlements-probe/inventory')
class InventoryProbeController {
  @RequirePermission('platform.users.read')
  @Get()
  list(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('platform.users.read')
  @RequireFeature('inventory.counts')
  @Get('counts')
  counts(): { ok: true } {
    return { ok: true };
  }
}

@Controller('entitlements-probe/billing')
class BillingProbeController {
  @RequirePermission('platform.users.read')
  @RequireFeature('billing')
  @Get()
  list(): { ok: true } {
    return { ok: true };
  }
}

const ACTOR = 'cli.entitlements';

describe('@RequireFeature', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let admin: EntitlementsAdmin;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [InventoryProbeController, BillingProbeController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    admin = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  /** An organization on a plan that enables nothing, and an Owner's token. */
  async function orgWithOwner(): Promise<{ org: SeededOrg; token: string }> {
    const org = await seed.org();
    await emptyPlanFor(org.id);
    const user = await seed.user();
    await seed.member(org.id, user, org.roles.owner);
    return { org, token: await seed.token(user, org.id) };
  }

  const get = (path: string, token: string) =>
    request(server)
      .get(`/api/v1/entitlements-probe/${path}`)
      .set('Authorization', `Bearer ${token}`);

  const expectDisabled = async (path: string, token: string, feature: string) => {
    const res = await get(path, token).expect(403);
    expect(res.body).toEqual({
      code: 'entitlements.feature_disabled',
      message: 'This feature is not included in your plan.',
      details: { feature },
    });
  };

  it('denies an organization whose plan lacks the feature; an override enables it', async () => {
    const { org, token } = await orgWithOwner();
    await expectDisabled('inventory', token, 'inventory');

    await admin.setOverride(org.id, 'inventory', true, undefined, ACTOR);
    await get('inventory', token).expect(200, { ok: true });
  });

  it('applies a plan switch on the next request, without a restart', async () => {
    const { org, token } = await orgWithOwner();
    await admin.setPlan(org.id, 'inventory', ACTOR);
    await get('inventory', token).expect(200);
    await get('inventory/counts', token).expect(200);
    await expectDisabled('billing', token, 'billing');

    await admin.setPlan(org.id, 'inventory_billing', ACTOR);
    await get('billing', token).expect(200);

    await admin.setPlan(org.id, 'inventory', ACTOR);
    await expectDisabled('billing', token, 'billing');
  });

  it('lets a disabling override win over the plan', async () => {
    const { org, token } = await orgWithOwner();
    await admin.setPlan(org.id, 'full', ACTOR);
    await admin.setOverride(org.id, 'inventory', false, undefined, ACTOR);
    await expectDisabled('inventory', token, 'inventory');
    // The controller's feature is checked first; inventory.counts is off through its dependency too.
    await expectDisabled('inventory/counts', token, 'inventory');

    await admin.clearOverride(org.id, 'inventory', ACTOR);
    await get('inventory/counts', token).expect(200);
  });

  it('keeps a feature off while a dependency is off, even if enabled by override', async () => {
    const { org, token } = await orgWithOwner();
    await admin.setOverride(org.id, 'inventory.counts', true, undefined, ACTOR);
    const entitlements = app.get(EntitlementService);
    const context = app.get(TenantContext);
    expect(
      await context.run({ tenantId: org.id, userId: org.id }, () =>
        entitlements.isEnabled('inventory.counts'),
      ),
    ).toBe(false);

    await admin.setPlan(org.id, 'full', ACTOR);
    await admin.setOverride(org.id, 'inventory', false, undefined, ACTOR);
    await admin.setOverride(org.id, 'inventory', true, undefined, ACTOR);
    await get('inventory/counts', token).expect(200);
  });

  it('checks the feature before the permission', async () => {
    const { org } = await orgWithOwner();
    const staff = await seed.user();
    await seed.member(org.id, staff, org.roles.staff);
    const token = await seed.token(staff, org.id);
    await expectDisabled('inventory', token, 'inventory');

    await admin.setPlan(org.id, 'full', ACTOR);
    const res = await get('inventory', token).expect(403);
    expect(res.body).toMatchObject({ code: 'rbac.permission_denied' });
  });

  it("never applies one organization's plan or overrides to another", async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    await admin.setPlan(a.org.id, 'full', ACTOR);
    await admin.setOverride(a.org.id, 'billing', false, undefined, ACTOR);

    await get('inventory', a.token).expect(200);
    await expectDisabled('billing', a.token, 'billing');
    await expectDisabled('inventory', b.token, 'inventory');

    // B's overrides are invisible to A and vice versa (RLS on tenant_feature_overrides).
    await admin.setOverride(b.org.id, 'billing', true, undefined, ACTOR);
    await get('billing', b.token).expect(200);
    await expectDisabled('billing', a.token, 'billing');
    const rowsSeenByA = await seed.as(a.org.id, (db) => db.tenantFeatureOverride.findMany());
    expect(rowsSeenByA.map((r) => r.tenantId)).toEqual([a.org.id]);
  });

  it('rejects writing an override into another tenant (RLS)', async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    await expect(
      seed.as(a.org.id, (db) =>
        db.tenantFeatureOverride.create({
          data: { tenantId: b.org.id, featureKey: 'inventory', enabled: true },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  describe('in jobs (no HTTP request)', () => {
    it('resolves inside TenantContext.run and reflects changes per scope', async () => {
      const { org } = await orgWithOwner();
      const entitlements = app.get(EntitlementService);
      const context = app.get(TenantContext);
      const asJob = <T>(fn: () => Promise<T>) =>
        context.run({ tenantId: org.id, userId: org.id }, fn);

      await expect(asJob(() => entitlements.assertEnabled('inventory'))).rejects.toMatchObject({
        code: 'entitlements.feature_disabled',
      });
      expect(await asJob(() => entitlements.getLimit('inventory', 'maxLocations'))).toBe(0);

      await admin.setPlan(org.id, 'inventory', ACTOR);
      expect(await asJob(() => entitlements.getLimit('inventory', 'maxLocations'))).toBeNull();

      await admin.setOverride(org.id, 'inventory', true, { maxLocations: 5 }, ACTOR);
      await expect(asJob(() => entitlements.assertEnabled('inventory'))).resolves.toBeUndefined();
      expect(await asJob(() => entitlements.getLimit('inventory', 'maxLocations'))).toBe(5);
    });

    it('caches per scope, so a change applies to the next scope', async () => {
      const { org } = await orgWithOwner();
      const entitlements = app.get(EntitlementService);
      const context = app.get(TenantContext);
      const cls = app.get(ClsService);
      expect(cls.isActive()).toBe(false);
      await context.run({ tenantId: org.id, userId: org.id }, async () => {
        expect(await entitlements.isEnabled('reports')).toBe(false);
        await admin.setPlan(org.id, 'full', ACTOR);
        // Same scope: the resolution of this "request" stays as loaded.
        expect(await entitlements.isEnabled('reports')).toBe(false);
      });
      expect(
        await context.run({ tenantId: org.id, userId: org.id }, () =>
          entitlements.isEnabled('reports'),
        ),
      ).toBe(true);
    });
  });
});
