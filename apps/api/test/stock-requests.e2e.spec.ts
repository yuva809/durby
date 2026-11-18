import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  requestDriverListResponseSchema,
  stockItemSchema,
  stockLevelListResponseSchema,
  stockRequestListResponseSchema,
  stockRequestSchema,
  type SystemRole,
  warehouseListResponseSchema,
  warehouseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/orders.md → Branch requests (ADR 0045): a branch requests, an admin approves, the warehouse packs (Main →
 * In transit), the driver delivers, the branch confirms (In transit → branch, the rest short).
 */
describe('branch stock requests (ADR 0045)', () => {
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

  /** A member with `role`, limited to `locations` when given. */
  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], { locations });
    return { userId, token: await seed.token(userId, org.id) };
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const post = (token: string, path: string, body: object = {}) =>
    withIdempotencyKey(auth(request(server).post(`/api/v1${path}`), token), uuidv7()).send(body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const [mainLocation, branchLocation] = org.locations;
    const owner = await member(org, 'owner');
    const warehouse = async (locationId: string, name: string) =>
      warehouseSchema.parse(
        (await post(owner.token, '/inventory/warehouses', { locationId, name }).expect(201)).body,
      ).id;
    const main = await warehouse(mainLocation, 'Main Warehouse');
    const branch = await warehouse(branchLocation, 'Kurfürstenstraße');
    const item = async (name: string) =>
      stockItemSchema.parse(
        (await post(owner.token, '/inventory/items', { name, unit: 'pc' }).expect(201)).body,
      ).id;
    const rice = await item('Rice');
    const oil = await item('Oil');
    await post(owner.token, '/inventory/receipts', {
      warehouseId: main,
      lines: [
        { itemId: rice, quantity: '10', unitCost: '2.00' },
        { itemId: oil, quantity: '4', unitCost: '5.00' },
      ],
    }).expect(201);
    return {
      org,
      owner,
      main,
      branch,
      rice,
      oil,
      branchUser: await member(org, 'branch', [branchLocation]),
      lager: await member(org, 'warehouse', [mainLocation]),
      driver: await member(org, 'driver'),
    };
  }

  const levels = async (token: string, warehouseId: string) =>
    Object.fromEntries(
      stockLevelListResponseSchema
        .parse((await get(token, `/inventory/stock?warehouseId=${warehouseId}`).expect(200)).body)
        .data.map((l) => [l.itemName, l.quantity]),
    );

  it('runs a request from the branch to the shelf and back to the branch, with stock following', async () => {
    const s = await setup();
    // The branch sees the main warehouse's quantities without inventory access there.
    const availability = (
      await get(s.branchUser.token, `/stock-requests/availability/${s.main}`).expect(200)
    ).body as { data: { itemName: string; available: string }[] };
    expect(availability.data.map((a) => [a.itemName, a.available])).toEqual([
      ['Oil', '4.000'],
      ['Rice', '10.000'],
    ]);
    // ...while its own stock view stays its own branch.
    expect(await levels(s.branchUser.token, s.main)).toEqual({});

    const created = stockRequestSchema.parse(
      (
        await post(s.branchUser.token, '/stock-requests', {
          fromWarehouseId: s.main,
          toWarehouseId: s.branch,
          lines: [
            { itemId: s.rice, quantity: '6' },
            { itemId: s.oil, quantity: '2' },
          ],
          note: 'For the weekend',
        }).expect(201)
      ).body,
    );
    expect(created).toMatchObject({ status: 'submitted', transferNumber: null });
    expect(created.number).toMatch(/^SRQ-\d{4}-\d{6}$/);
    const riceLine = created.lines[0]!;
    const oilLine = created.lines[1]!;

    // Only owner and admin approve.
    await post(s.lager.token, `/stock-requests/${created.id}/approve`, {
      lines: [{ lineId: riceLine.id, quantity: '5' }],
    }).expect(403);
    const approved = stockRequestSchema.parse(
      (
        await post(s.owner.token, `/stock-requests/${created.id}/approve`, {
          lines: [
            { lineId: riceLine.id, quantity: '5' },
            { lineId: oilLine.id, quantity: '0' },
          ],
        }).expect(201)
      ).body,
    );
    expect(approved.status).toBe('approved');
    expect(approved.transferNumber).toMatch(/^TRF-\d{4}-\d{6}$/);

    // The warehouse picks 4 of 5 and assigns the driver.
    const drivers = requestDriverListResponseSchema.parse(
      (await get(s.lager.token, `/stock-requests/drivers/${s.main}`).expect(200)).body,
    );
    expect(drivers.data.map((d) => d.userId)).toContain(s.driver.userId);
    await post(s.lager.token, `/stock-requests/${created.id}/pack`, {
      lines: [{ lineId: riceLine.id, quantity: '6' }],
    }).expect(400);
    const packed = stockRequestSchema.parse(
      (
        await post(s.lager.token, `/stock-requests/${created.id}/pack`, {
          lines: [{ lineId: riceLine.id, quantity: '4' }],
          driverUserId: s.driver.userId,
        }).expect(201)
      ).body,
    );
    expect(packed).toMatchObject({ status: 'packed', driverUserId: s.driver.userId });
    expect(await levels(s.owner.token, s.main)).toEqual({ Oil: '4.000', Rice: '6.000' });
    const transit = warehouseListResponseSchema
      .parse((await get(s.owner.token, '/inventory/warehouses').expect(200)).body)
      .data.find((w) => w.isTransit);
    expect(transit).toBeDefined();
    expect(await levels(s.owner.token, transit!.id)).toEqual({ Rice: '4.000' });

    // The driver sees only their deliveries and moves them; to another driver the request doesn't
    // exist (StockRequestsService.readable hides what you may not see).
    const mine = stockRequestListResponseSchema.parse(
      (await get(s.driver.token, '/stock-requests?mine=true').expect(200)).body,
    );
    expect(mine.data.map((r) => r.id)).toEqual([created.id]);
    const other = await member(s.org, 'driver');
    const hidden = await post(other.token, `/stock-requests/${created.id}/pick-up`).expect(404);
    expect(hidden.body).toMatchObject({ code: 'orders.request_not_found' });
    await post(s.driver.token, `/stock-requests/${created.id}/pick-up`).expect(201);
    await post(s.driver.token, `/stock-requests/${created.id}/deliver`, {
      note: 'Ms Weber',
    }).expect(201);

    // The branch confirms 3 of 4: 3 into the branch, 1 booked short out of transit.
    const received = stockRequestSchema.parse(
      (
        await post(s.branchUser.token, `/stock-requests/${created.id}/receive`, {
          lines: [{ lineId: riceLine.id, quantity: '3' }],
        }).expect(201)
      ).body,
    );
    expect(received.status).toBe('received');
    expect(
      received.lines.map((l) => [l.approvedQuantity, l.pickedQuantity, l.receivedQuantity]),
    ).toEqual([
      ['5.000', '4.000', '3.000'],
      ['0.000', '0.000', '0.000'],
    ]);
    expect(received.events.map((e) => e.status)).toEqual([
      'submitted',
      'approved',
      'packed',
      'in_transit',
      'delivered',
      'received',
    ]);
    expect(await levels(s.owner.token, s.branch)).toEqual({ Rice: '3.000' });
    expect(await levels(s.owner.token, transit!.id)).toEqual({ Rice: '0.000' });
  });

  it('shows a branch only its own requests, and lets it cancel before approval', async () => {
    const s = await setup();
    const created = stockRequestSchema.parse(
      (
        await post(s.branchUser.token, '/stock-requests', {
          fromWarehouseId: s.main,
          toWarehouseId: s.branch,
          lines: [{ itemId: s.rice, quantity: '1' }],
        }).expect(201)
      ).body,
    );
    // A branch can't request into a warehouse of another location.
    await post(s.branchUser.token, '/stock-requests', {
      fromWarehouseId: s.branch,
      toWarehouseId: s.main,
      lines: [{ itemId: s.rice, quantity: '1' }],
    }).expect(403);
    await get(s.driver.token, `/stock-requests/${created.id}`).expect(404);
    await post(s.branchUser.token, `/stock-requests/${created.id}/cancel`).expect(201);
    await post(s.owner.token, `/stock-requests/${created.id}/approve`, {
      lines: [{ lineId: created.lines[0]!.id, quantity: '1' }],
    }).expect(409);
  });

  it('refuses to pack more than is on the shelf', async () => {
    const s = await setup();
    const created = stockRequestSchema.parse(
      (
        await post(s.branchUser.token, '/stock-requests', {
          fromWarehouseId: s.main,
          toWarehouseId: s.branch,
          lines: [{ itemId: s.oil, quantity: '9' }],
        }).expect(201)
      ).body,
    );
    const line = created.lines[0]!.id;
    await post(s.owner.token, `/stock-requests/${created.id}/approve`, {
      lines: [{ lineId: line, quantity: '9' }],
    }).expect(201);
    const res = await post(s.lager.token, `/stock-requests/${created.id}/pack`, {
      lines: [{ lineId: line, quantity: '9' }],
    }).expect(409);
    expect((res.body as { code: string }).code).toBe('inventory.insufficient_stock');
  });
});
