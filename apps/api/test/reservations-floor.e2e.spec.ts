import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  productCategorySchema,
  productSchema,
  reservationsFloorResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → Derived floor state (R1.1 part): which tables are occupied, for
 * roles without pos order keys (Host). Occupancy comes from pos's read port, without order data.
 */
describe('GET /reservations/floor', () => {
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
  const post = (token: string, path: string, body: unknown) =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  /** On `full`: T1 (occupied, 2 guests) and T2 (free) at the first location, T9 at the second. */
  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const [here, there] = org.locations;
    const table = async (locationId: string, name: string, sortOrder: number) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4, sortOrder }).expect(201))
          .body,
      ).id;
    const t1 = await table(here, 'T1', 1);
    const t2 = await table(here, 'T2', 2);
    await table(there, 'T9', 1);
    const category = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const soup = productSchema.parse(
      (
        await post(owner, '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        }).expect(201)
      ).body,
    );
    await post(owner, `/pos/tables/${t1}/tickets`, {
      lines: [{ productId: soup.id, quantity: 1 }],
      covers: 2,
    }).expect(201);
    return { org, owner, here, there, t1, t2 };
  }

  it('shows a Host-only user which tables are occupied, without any order data', async () => {
    const r = await restaurant();
    const host = await memberToken(r.org, 'host');
    // The pos floor needs pos.orders.read, which Host doesn't hold: occupancy comes from here.
    const denied = await get(host, `/pos/floor?locationId=${r.here}`).expect(403);
    expect(denied.body).toMatchObject({ details: { permission: 'pos.orders.read' } });

    const res = await get(host, `/reservations/floor?locationId=${r.here}`).expect(200);
    const floor = reservationsFloorResponseSchema.parse(res.body);
    expect(floor.data.map((t) => [t.name, t.occupied, t.covers])).toEqual([
      ['T1', true, 2],
      ['T2', false, null],
    ]);
    expect(Date.parse(floor.data[0]!.occupiedSince ?? '')).not.toBeNaN();
    expect(floor.data[1]!.occupiedSince).toBeNull();
    // Table and occupancy only: no order id, number, items or totals.
    expect(Object.keys((res.body as { data: object[] }).data[0]!).sort()).toEqual([
      'area',
      'areaId',
      'color',
      'covers',
      'id',
      'locationId',
      'name',
      'occupied',
      'occupiedSince',
      'seats',
      'shape',
      'sortOrder',
    ]);
  });

  it('frees the table when the order is closed', async () => {
    const r = await restaurant();
    const host = await memberToken(r.org, 'host');
    const order = (await get(r.owner, `/pos/tables/${r.t1}/order`).expect(200)).body as {
      order: { id: string };
    };
    await post(r.owner, `/pos/orders/${order.order.id}/close`, {}).expect(201);
    const floor = reservationsFloorResponseSchema.parse(
      (await get(host, `/reservations/floor?locationId=${r.here}`).expect(200)).body,
    );
    expect(floor.data.map((t) => t.occupied)).toEqual([false, false]);
  });

  it('is for holders of reservations.bookings.read at that location', async () => {
    const r = await restaurant();
    for (const role of ['waiter', 'manager', 'admin', 'owner'] as const) {
      await get(await memberToken(r.org, role), `/reservations/floor?locationId=${r.here}`).expect(
        200,
      );
    }
    for (const role of ['staff', 'cashier'] as const) {
      const res = await get(
        await memberToken(r.org, role),
        `/reservations/floor?locationId=${r.here}`,
      ).expect(403);
      expect(res.body).toMatchObject({
        code: 'rbac.permission_denied',
        details: { permission: 'reservations.bookings.read' },
      });
    }
    // A host limited to the first location: the second doesn't exist for them.
    const limited = await memberToken(r.org, 'host', [r.here]);
    await get(limited, `/reservations/floor?locationId=${r.here}`).expect(200);
    const other = await get(limited, `/reservations/floor?locationId=${r.there}`).expect(404);
    expect(other.body).toMatchObject({ code: 'reservations.location_not_found' });
  });

  it('answers 404 for unknown locations, 400 for a malformed or missing id', async () => {
    const r = await restaurant();
    const host = await memberToken(r.org, 'host');
    const unknown = await get(host, `/reservations/floor?locationId=${uuidv7()}`).expect(404);
    expect(unknown.body).toMatchObject({ code: 'reservations.location_not_found' });
    await get(host, '/reservations/floor?locationId=nope').expect(400);
    await get(host, '/reservations/floor').expect(400);
  });

  it('needs the reservations feature', async () => {
    const r = await restaurant();
    const host = await memberToken(r.org, 'host');
    await entitlements.setOverride(r.org.id, 'reservations', false, undefined, 'cli.entitlements');
    const res = await get(host, `/reservations/floor?locationId=${r.here}`).expect(403);
    expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
  });

  it("never shows another organization's floor", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const hostB = await memberToken(b.org, 'host');
    const res = await get(hostB, `/reservations/floor?locationId=${a.here}`).expect(404);
    expect(res.body).toMatchObject({ code: 'reservations.location_not_found' });
  });
});
