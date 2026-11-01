import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DEFAULT_OPENING_HOURS,
  RESERVATION_LOCATION_SETTING_KEYS,
  reservationSettingsResponseSchema,
  resolvedSettingSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { SettingsAdmin } from '../src/platform/config/settings';
import { TenantContext } from '../src/platform/tenancy';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → R1.5c location settings API (ADR 0020): reservations.setup.manage
 * edits the location's own reservations.* settings through SettingsAdmin.
 */
describe('reservations: location settings', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const send = (
    token: string,
    method: 'put' | 'delete',
    path: string,
    body?: unknown,
    key = uuidv7(),
  ) => {
    const req = request(server)
      [method](`/api/v1${path}`)
      .set('Idempotency-Key', key)
      .auth(token, { type: 'bearer' });
    return body === undefined ? req : req.send(body as object);
  };

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const [here, there] = org.locations;
    return {
      org,
      here,
      there,
      owner: await memberToken(org, 'owner'),
      manager: await memberToken(org, 'manager'),
    };
  }

  const settingsAt = async (token: string, locationId: string) =>
    reservationSettingsResponseSchema.parse(
      (await get(token, `/reservations/settings?locationId=${locationId}`).expect(200)).body,
    );
  const valueOf = (s: Awaited<ReturnType<typeof settingsAt>>, key: string) =>
    s.data.find((x) => x.key === key);
  const put = (token: string, key: string, locationId: string, value: unknown, k?: string) =>
    send(token, 'put', `/reservations/settings/${key}?locationId=${locationId}`, { value }, k);
  const inherit = (token: string, key: string, locationId: string) =>
    send(token, 'delete', `/reservations/settings/${key}?locationId=${locationId}`);

  it("lists the location's reservations settings with their source, and the opening hours", async () => {
    const r = await restaurant();
    const s = await settingsAt(r.manager, r.here);
    expect(s.data.map((x) => x.key)).toEqual([...RESERVATION_LOCATION_SETTING_KEYS]);
    expect(s.data.every((x) => x.key.startsWith('reservations.'))).toBe(true);
    expect(valueOf(s, 'reservations.slotIntervalMinutes')).toMatchObject({
      value: 15,
      source: 'default',
    });
    expect(s.openingHours).toEqual(DEFAULT_OPENING_HOURS);
  });

  it('lets a manager set a value at one location and inherit it again', async () => {
    const r = await restaurant();
    const saved = resolvedSettingSchema.parse(
      (await put(r.manager, 'reservations.slotIntervalMinutes', r.here, 30).expect(200)).body,
    );
    expect(saved).toMatchObject({ value: 30, source: 'location' });
    expect(
      valueOf(await settingsAt(r.manager, r.here), 'reservations.slotIntervalMinutes'),
    ).toMatchObject({ value: 30, source: 'location' });
    expect(
      valueOf(await settingsAt(r.manager, r.there), 'reservations.slotIntervalMinutes'),
    ).toMatchObject({ value: 15, source: 'default' });
    await inherit(r.manager, 'reservations.slotIntervalMinutes', r.here).expect(204);
    expect(
      valueOf(await settingsAt(r.manager, r.here), 'reservations.slotIntervalMinutes'),
    ).toMatchObject({ value: 15, source: 'default' });
    await inherit(r.manager, 'reservations.slotIntervalMinutes', r.here).expect(204); // no-op

    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'setting_value' },
        orderBy: { id: 'asc' },
        select: { action: true, after: true },
      }),
    );
    expect(rows.map((x) => x.action)).toEqual([
      'platform.setting_value.created',
      'platform.setting_value.deleted',
    ]);
    expect(rows[0]?.after).toMatchObject({
      key: 'reservations.slotIntervalMinutes',
      scopeType: 'location',
      locationId: r.here,
      value: '30',
    });
  });

  it('validates values like the settings api and saves wider service hours', async () => {
    const r = await restaurant();
    const res = await put(r.manager, 'reservations.slotIntervalMinutes', r.here, 20).expect(422);
    expect(res.body).toMatchObject({ code: 'settings.invalid_value' });
    await put(r.manager, 'reservations.maxCoversPerSlot', r.here, null).expect(422);
    await send(
      r.manager,
      'put',
      `/reservations/settings/reservations.slotIntervalMinutes?locationId=${r.here}`,
      {},
    ).expect(400);
    // Wider than the opening hours (11–23): saved; the tab explains it, the engine intersects.
    const wide = { ...DEFAULT_OPENING_HOURS, sat: [{ from: '10:00', to: '23:30' }] };
    await put(r.manager, 'reservations.serviceHours', r.here, wide).expect(200);
  });

  it('never edits platform keys or other modules’ keys', async () => {
    const r = await restaurant();
    for (const key of ['openingHours', 'closedDates', 'timezone', 'inventory.allowNegativeStock']) {
      await put(r.owner, key, r.here, []).expect(400);
      await inherit(r.owner, key, r.here).expect(400);
    }
    // Nor through the platform settings api without platform.settings.manage.
    const res = await request(server)
      .put(`/api/v1/settings/reservations.slotIntervalMinutes?locationId=${r.here}`)
      .set('Idempotency-Key', uuidv7())
      .auth(r.manager, { type: 'bearer' })
      .send({ value: 30 })
      .expect(403);
    expect(res.body).toMatchObject({ details: { permission: 'platform.settings.manage' } });
  });

  it('refuses delegated writes outside the module or the location (ADR 0020)', async () => {
    const r = await restaurant();
    const admin = app.get(SettingsAdmin);
    const delegated = { permission: 'reservations.setup.manage' as const };
    await app.get(TenantContext).run({ tenantId: r.org.id, userId: uuidv7() }, async () => {
      await expect(
        admin.set('openingHours', { locationId: r.here }, DEFAULT_OPENING_HOURS, delegated),
      ).rejects.toThrow('ADR 0020');
      await expect(
        admin.set('reservations.holdMinutes', {}, 6, delegated), // organization scope
      ).rejects.toThrow('ADR 0020');
      await expect(
        admin.remove('inventory.allowNegativeStock', { locationId: r.here }, delegated),
      ).rejects.toThrow('ADR 0020');
    });
  });

  it('replays a repeated PUT', async () => {
    const r = await restaurant();
    const key = uuidv7();
    const first = await put(r.manager, 'reservations.holdMinutes', r.here, 7, key).expect(200);
    const again = await put(r.manager, 'reservations.holdMinutes', r.here, 7, key).expect(200);
    expect(again.body).toEqual(first.body);
  });

  describe('access', () => {
    it('is for holders of reservations.setup.manage at the location', async () => {
      const r = await restaurant();
      for (const role of ['admin', 'owner'] as const) {
        const token = await memberToken(r.org, role);
        await put(token, 'reservations.holdMinutes', r.here, 6).expect(200);
      }
      for (const role of ['waiter', 'host', 'staff', 'cashier'] as const) {
        const token = await memberToken(r.org, role);
        const res = await get(token, `/reservations/settings?locationId=${r.here}`).expect(403);
        expect(res.body).toMatchObject({ details: { permission: 'reservations.setup.manage' } });
        await put(token, 'reservations.holdMinutes', r.here, 6).expect(403);
      }
      const limited = await memberToken(r.org, 'manager', [r.there]);
      for (const res of [
        await get(limited, `/reservations/settings?locationId=${r.here}`),
        await put(limited, 'reservations.holdMinutes', r.here, 6),
        await inherit(limited, 'reservations.holdMinutes', r.here),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'reservations.location_not_found' });
      }
      await put(limited, 'reservations.holdMinutes', r.there, 6).expect(200);
    });

    it("never reads or changes another organization's location", async () => {
      const a = await restaurant();
      const b = await restaurant();
      await get(b.manager, `/reservations/settings?locationId=${a.here}`).expect(404);
      await put(b.manager, 'reservations.holdMinutes', a.here, 6).expect(404);
      await inherit(b.manager, 'reservations.holdMinutes', a.here).expect(404);
      await get(a.manager, `/reservations/settings?locationId=${uuidv7()}`).expect(404);
      expect(
        valueOf(await settingsAt(a.manager, a.here), 'reservations.holdMinutes'),
      ).toMatchObject({ source: 'default' });
    });

    it('needs the reservations feature', async () => {
      const r = await restaurant();
      await entitlements.setOverride(
        r.org.id,
        'reservations',
        false,
        undefined,
        'cli.entitlements',
      );
      for (const res of [
        await get(r.manager, `/reservations/settings?locationId=${r.here}`),
        await put(r.manager, 'reservations.holdMinutes', r.here, 6),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
      }
    });
  });
});
