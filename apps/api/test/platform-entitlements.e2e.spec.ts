import {
  berlinDate,
  type CustomerEntitlements,
  customerDetailSchema,
  customerEntitlementsSchema,
  FEATURE_KEYS,
  featureCatalogResponseSchema,
  meEntitlementsResponseSchema,
} from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthTestKit, startAuthApp } from './support/auth-app';
import { RbacSeed } from './support/rbac';
import { signedInStaff, type StaffBrowser } from './support/staff';

/** docs/platform/admin-portal.md → Modules (step 1d). */
describe('/api/v1/platform module switches', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
  });

  afterAll(async () => {
    await kit.close();
  });

  const onboard = async (browser: StaffBrowser, extra: object = {}, status = 201) =>
    browser
      .send(
        'post',
        '/customers',
        {
          name: `Cafe ${uuidv7().slice(-8)}`,
          ownerEmail: `owner-${uuidv7()}@example.test`,
          ...extra,
        },
        { headers: { 'Idempotency-Key': uuidv7() } },
      )
      .expect(status);

  async function newCustomer(browser: StaffBrowser, extra: object = {}): Promise<string> {
    return customerDetailSchema.parse((await onboard(browser, extra)).body).id;
  }

  const state = async (browser: StaffBrowser, id: string) =>
    customerEntitlementsSchema.parse(
      (await browser.send('get', `/customers/${id}/entitlements`).expect(200)).body,
    );

  const feature = (s: CustomerEntitlements, key: string) => s.features.find((f) => f.key === key)!;
  const enabledKeys = (s: CustomerEntitlements) =>
    s.features.filter((f) => f.enabled).map((f) => f.key);

  const put = (browser: StaffBrowser, id: string, key: string, body: object, status = 200) =>
    browser.send('put', `/customers/${id}/features/${key}`, body).expect(status);
  const reset = (browser: StaffBrowser, id: string, key: string, body: object, status = 200) =>
    browser.send('post', `/customers/${id}/features/${key}/reset`, body).expect(status);

  /** The customer's Owner, as their own app sees them. */
  async function ownerToken(customerId: string): Promise<string> {
    const owner = await seed.as(customerId, (db) =>
      db.membership.findFirstOrThrow({ select: { userId: true } }),
    );
    return seed.token(owner.userId, customerId);
  }
  const customerFeatures = async (token: string) =>
    meEntitlementsResponseSchema
      .parse(
        (
          await request(kit.server)
            .get('/api/v1/me/entitlements')
            .set('Authorization', `Bearer ${token}`)
            .expect(200)
        ).body,
      )
      .features.map((f) => f.key);

  it('lists every registry key in the catalog, grouped by module, with what each plan includes', async () => {
    const { browser } = await signedInStaff(kit, 'support');
    const catalog = featureCatalogResponseSchema.parse(
      (await browser.send('get', '/feature-catalog').expect(200)).body,
    );
    const keys = catalog.modules.flatMap((m) => [m.key, ...m.features.map((f) => f.key)]);
    expect([...keys].sort()).toEqual([...FEATURE_KEYS].sort());
    expect(catalog.modules[0]).toMatchObject({ label: 'platform.features.catalog.name' });
    const pos = catalog.modules.find((m) => m.key === 'pos');
    expect(pos).toMatchObject({ dependsOn: ['catalog'], features: [{ key: 'pos.fiscal' }] });
    expect(catalog.plans.find((p) => p.key === 'inventory')?.features).not.toContain('pos');
    expect(catalog.plans.map((p) => p.key)).toEqual(['inventory', 'inventory_billing', 'full']);
  });

  it('onboards with a custom module set: the differences become overrides, audited in both logs', async () => {
    const { browser, id: staffId } = await signedInStaff(kit, 'onboarding');
    const off = { inventory: false, reservations: false, 'reservations.online': false };
    const id = await newCustomer(browser, {
      plan: 'full',
      features: {
        catalog: true,
        pos: true,
        ...off,
        'inventory.counts': false,
        'inventory.purchasing': false,
      },
    });
    const s = await state(browser, id);
    expect(enabledKeys(s)).not.toContain('inventory');
    expect(enabledKeys(s)).toEqual(expect.arrayContaining(['catalog', 'pos', 'pos.fiscal']));
    // Only the differences from the plan (catalog and pos are in full: no override).
    const overridden = s.features.filter((f) => f.override).map((f) => f.key);
    expect(overridden.sort()).toEqual(
      [
        'inventory',
        'inventory.counts',
        'inventory.purchasing',
        'reservations',
        'reservations.online',
      ].sort(),
    );
    expect(feature(s, 'inventory').override).toMatchObject({
      enabled: false,
      reason: 'onboarding',
      setBy: { id: staffId },
    });

    const tenantLog = await seed.as(id, (db) =>
      db.auditLog.findMany({ where: { action: 'platform.feature_override.created' } }),
    );
    expect(tenantLog).toHaveLength(5);
    expect(tenantLog[0]).toMatchObject({ actorSystem: 'staff.admin_portal' });
    const platform = await kit.raw.platformAuditLog.findMany({
      where: { organizationId: id, action: 'staff.feature_override.created' },
    });
    expect(platform).toHaveLength(5);
    expect(platform[0]).toMatchObject({ actorStaffId: staffId, reason: 'onboarding' });
  });

  it('refuses an onboarding module set with a gap (409, nothing created)', async () => {
    const { browser } = await signedInStaff(kit);
    const name = `Gap ${uuidv7().slice(-8)}`;
    const res = await onboard(browser, { name, features: { catalog: false } }, 409);
    // full has pos and reservations: both need catalog (reservations through pos).
    expect(res.body).toMatchObject({
      code: 'staff.feature_dependency_missing',
      details: { missing: ['catalog'] },
    });
    expect(await kit.raw.organization.count({ where: { name } })).toBe(0);
    await onboard(browser, { features: { 'no.such': true } }, 400);
  });

  it('switches a module on and off with reason and expiry, resets it, and the customer sees it at once', async () => {
    const { browser, id: staffId, email } = await signedInStaff(kit, 'onboarding');
    const id = await newCustomer(browser, { plan: 'inventory' });
    const token = await ownerToken(id);
    expect(await customerFeatures(token)).not.toContain('pos');

    const on = customerEntitlementsSchema.parse(
      (await put(browser, id, 'pos', { enabled: true, reason: 'Trial', expiresOn: '2099-10-25' }))
        .body,
    );
    expect(feature(on, 'pos')).toMatchObject({
      enabled: true,
      source: 'override',
      override: {
        reason: 'Trial',
        expiresOn: '2099-10-25',
        expired: false,
        setBy: { id: staffId, email },
      },
    });
    expect(await customerFeatures(token)).toContain('pos');
    const row = await seed.as(id, (db) =>
      db.tenantFeatureOverride.findFirstOrThrow({ where: { featureKey: 'pos' } }),
    );
    // End of that day in Berlin (the fall-back day: CET, UTC+1).
    expect(row.expiresAt?.toISOString()).toBe('2099-10-25T22:59:59.999Z');
    expect(berlinDate(row.expiresAt!)).toBe('2099-10-25');

    // The same body again is no change: no second audit row.
    await put(browser, id, 'pos', {
      enabled: true,
      reason: 'Trial again',
      expiresOn: '2099-10-25',
    });
    const reset1 = customerEntitlementsSchema.parse(
      (await reset(browser, id, 'pos', { reason: 'Trial over' })).body,
    );
    expect(feature(reset1, 'pos')).toMatchObject({
      enabled: false,
      source: 'plan',
      override: null,
    });
    expect(await customerFeatures(token)).not.toContain('pos');
    await reset(browser, id, 'pos', { reason: 'Again' });

    const tenantLog = await seed.as(id, (db) =>
      db.auditLog.findMany({
        where: { action: { startsWith: 'platform.feature_override' } },
        orderBy: { id: 'asc' },
      }),
    );
    expect(tenantLog.map((r) => r.action)).toEqual([
      'platform.feature_override.created',
      'platform.feature_override.deleted',
    ]);
    expect(tenantLog[0]?.after).toMatchObject({
      featureKey: 'pos',
      enabled: true,
      reason: 'Trial',
      expiresAt: '2099-10-25T22:59:59.999Z',
      setByStaffId: staffId,
    });
    const platform = await kit.raw.platformAuditLog.findMany({
      where: { organizationId: id, action: { startsWith: 'staff.feature_override' } },
      orderBy: { id: 'asc' },
    });
    expect(platform.map((r) => [r.action, r.reason, r.actorStaffId])).toEqual([
      ['staff.feature_override.created', 'Trial', staffId],
      ['staff.feature_override.deleted', 'Trial over', staffId],
    ]);
    expect(platform[0]?.after).toEqual({
      id: tenantLog[0]?.entityId,
      featureKey: 'pos',
      enabled: true,
      limits: null,
      expiresAt: '2099-10-25T22:59:59.999Z',
    });
  });

  it('changes the plan and keeps the overrides', async () => {
    const { browser } = await signedInStaff(kit);
    const id = await newCustomer(browser, { plan: 'full' });
    await put(browser, id, 'reports', { enabled: false, reason: 'Not used' });
    const s = customerEntitlementsSchema.parse(
      (
        await browser
          .send('put', `/customers/${id}/plan`, { plan: 'inventory', reason: 'Downgrade' })
          .expect(200)
      ).body,
    );
    expect(s.plan).toBe('inventory');
    expect(feature(s, 'reports')).toMatchObject({ enabled: false, source: 'override' });
    expect(feature(s, 'pos')).toMatchObject({ enabled: false, source: 'plan' });
    const platform = await kit.raw.platformAuditLog.findFirstOrThrow({
      where: { organizationId: id, action: 'staff.customer.plan_changed' },
    });
    expect(platform.reason).toBe('Downgrade');
  });

  it('409 when enabling a feature whose dependency is off; disabling a dependency lists what it blocks', async () => {
    const { browser } = await signedInStaff(kit);
    const id = await newCustomer(browser, { plan: 'inventory' });
    const refused = await put(browser, id, 'reservations', { enabled: true, reason: 'x' }, 409);
    expect(refused.body).toMatchObject({
      code: 'staff.feature_dependency_missing',
      details: { missing: ['pos'] },
    });
    // Nothing written.
    expect(feature(await state(browser, id), 'reservations').override).toBeNull();

    const full = await newCustomer(browser, { plan: 'full' });
    const off = customerEntitlementsSchema.parse(
      (await put(browser, full, 'catalog', { enabled: false, reason: 'Paused' })).body,
    );
    expect(feature(off, 'pos')).toMatchObject({
      enabled: false,
      source: 'dependency',
      blockedBy: ['catalog'],
    });
    expect(feature(off, 'reservations').blockedBy).toEqual(['pos', 'catalog']);
  });

  it('treats an expired override as absent: the plan applies', async () => {
    const { browser } = await signedInStaff(kit);
    const id = await newCustomer(browser, { plan: 'full' });
    await seed.as(id, (db) =>
      db.tenantFeatureOverride.create({
        data: {
          tenantId: id,
          featureKey: 'inventory',
          enabled: false,
          expiresAt: new Date(Date.now() - 1000),
        },
      }),
    );
    expect(feature(await state(browser, id), 'inventory')).toMatchObject({
      enabled: true,
      source: 'expired-override',
      override: { expired: true },
    });
    expect(await customerFeatures(await ownerToken(id))).toContain('inventory');
  });

  it('validates input', async () => {
    const { browser } = await signedInStaff(kit);
    const id = await newCustomer(browser);
    const code = async (res: Promise<{ body: unknown }>) =>
      ((await res).body as { code: string }).code;
    expect(await code(put(browser, id, 'nope', { enabled: true, reason: 'x' }, 400))).toBe(
      'staff.feature_unknown',
    );
    expect(await code(reset(browser, id, 'nope', { reason: 'x' }, 400))).toBe(
      'staff.feature_unknown',
    );
    expect(
      await code(
        put(
          browser,
          id,
          'inventory',
          { enabled: true, reason: 'x', limits: { maxLocations: 0 } },
          400,
        ),
      ),
    ).toBe('staff.feature_limits_invalid');
    expect(
      await code(
        put(
          browser,
          id,
          'inventory',
          { enabled: false, reason: 'x', limits: { maxLocations: 2 } },
          400,
        ),
      ),
    ).toBe('staff.feature_limits_invalid');
    expect(
      await code(
        put(browser, id, 'inventory', { enabled: true, reason: 'x', expiresOn: '2020-01-01' }, 400),
      ),
    ).toBe('staff.expiry_past');
    await put(
      browser,
      id,
      'inventory',
      { enabled: true, reason: 'x', expiresOn: '2099-02-30' },
      400,
    );
    await put(
      browser,
      id,
      'inventory',
      { enabled: true, reason: 'x', expiresOn: '2099-01-01T10:00' },
      400,
    );
    await put(browser, id, 'inventory', { enabled: true }, 400);
    await put(browser, id, 'inventory', { enabled: true, reason: '   ' }, 400);
    await put(browser, id, 'inventory', { enabled: true, reason: 'x'.repeat(501) }, 400);
    await reset(browser, id, 'inventory', {}, 400);
    await browser.send('put', `/customers/${id}/plan`, { plan: 'gold', reason: 'x' }).expect(400);
    await browser.send('put', `/customers/${id}/plan`, { plan: 'full' }).expect(400);
    const missing = await put(browser, uuidv7(), 'inventory', { enabled: true, reason: 'x' }, 404);
    expect(missing.body).toMatchObject({ code: 'staff.customer_not_found' });
    // Limits a staff member may set are stored and returned.
    const limited = customerEntitlementsSchema.parse(
      (
        await put(browser, id, 'inventory', {
          enabled: true,
          reason: 'x',
          limits: { maxLocations: 2 },
        })
      ).body,
    );
    expect(feature(limited, 'inventory').override?.limits).toEqual({ maxLocations: 2 });
  });

  it('lets support read but not write, rejects customer tokens, and needs a fresh session', async () => {
    const { browser: admin } = await signedInStaff(kit);
    const id = await newCustomer(admin);
    const { browser: support } = await signedInStaff(kit, 'support');
    await state(support, id);
    const denied = await put(support, id, 'pos', { enabled: false, reason: 'x' }, 403);
    expect(denied.body).toMatchObject({
      code: 'staff.permission_denied',
      details: { permission: 'staff.entitlements.manage' },
    });
    await reset(support, id, 'pos', { reason: 'x' }, 403);
    await support.send('put', `/customers/${id}/plan`, { plan: 'full', reason: 'x' }).expect(403);

    const customer = await request(kit.server)
      .get(`/api/v1/platform/customers/${id}/entitlements`)
      .set('Authorization', `Bearer ${await ownerToken(id)}`)
      .expect(401);
    expect(customer.body).toMatchObject({ code: 'staff.unauthenticated' });

    kit.clock.advance(16 * 60_000);
    const stale = await put(admin, id, 'pos', { enabled: false, reason: 'x' }, 401);
    expect(stale.body).toMatchObject({ code: 'staff.reauth_required' });
    // Reading needs no fresh session.
    await state(admin, id);
  });
});
