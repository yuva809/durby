import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  stockDocumentListResponseSchema,
  stockDocumentSchema,
  stockItemSchema,
  stockLevelListResponseSchema,
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

/** docs/modules/inventory.md (ADR 0027): warehouses, items, receipts, adjustments, transfers, stock. */
describe('inventory', () => {
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

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1/inventory${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: unknown, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1/inventory${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body as object);
  const patch = (token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1/inventory${path}`).auth(token, { type: 'bearer' }),
    ).send(body as object);
  const putSetting = (token: string, key: string, value: unknown) =>
    withIdempotencyKey(
      request(server).put(`/api/v1/settings/${key}`).auth(token, { type: 'bearer' }),
    ).send({ value });

  /** An organization with a main store and a bar at location 1, a store at location 2, two items. */
  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const warehouse = async (locationId: string, name: string) =>
      warehouseSchema.parse(
        (await post(owner, '/warehouses', { locationId, name }).expect(201)).body,
      ).id;
    const item = async (name: string, unit: string, minQuantity?: string) =>
      stockItemSchema.parse(
        (
          await post(owner, '/items', {
            name,
            unit,
            ...(minQuantity ? { minQuantity } : {}),
          }).expect(201)
        ).body,
      ).id;
    return {
      org,
      owner,
      main: await warehouse(org.locations[0], 'Main store'),
      bar: await warehouse(org.locations[0], 'Bar'),
      far: await warehouse(org.locations[1], 'Store 2'),
      tomatoes: await item('Tomatoes', 'kg', '5'),
      cola: await item('Cola 0.33', 'pc'),
    };
  }

  const stockOf = async (token: string, warehouseId: string) =>
    Object.fromEntries(
      stockLevelListResponseSchema
        .parse((await get(token, `/stock?warehouseId=${warehouseId}`).expect(200)).body)
        .data.map((l) => [l.itemName, [l.quantity, l.averageCost, l.value, l.low]]),
    );

  it('receives deliveries at weighted average cost and numbers each document', async () => {
    const s = await setup();
    const year = new Date().getUTCFullYear();
    const first = stockDocumentSchema.parse(
      (
        await post(s.owner, '/receipts', {
          warehouseId: s.main,
          supplier: 'Metro',
          lines: [
            { itemId: s.tomatoes, quantity: '10', unitCost: '2.5' },
            { itemId: s.cola, quantity: '24', unitCost: '0.45' },
          ],
        }).expect(201)
      ).body,
    );
    expect(first).toMatchObject({
      number: `GR-${year}-000001`,
      kind: 'receipt',
      supplier: 'Metro',
      lineCount: 2,
      value: '35.80',
    });
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.tomatoes, quantity: '5', unitCost: '4' }],
    }).expect(201);
    expect(await stockOf(s.owner, s.main)).toEqual({
      'Cola 0.33': ['24.000', '0.4500', '10.80', false],
      Tomatoes: ['15.000', '3.0000', '45.00', false],
    });
  });

  it('adjusts waste out at the average, and refuses going below zero unless allowed', async () => {
    const s = await setup();
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.tomatoes, quantity: '6', unitCost: '3' }],
    }).expect(201);
    const waste = stockDocumentSchema.parse(
      (
        await post(s.owner, '/adjustments', {
          warehouseId: s.main,
          reason: 'waste',
          note: 'mouldy',
          lines: [{ itemId: s.tomatoes, quantity: '-1.5' }],
        }).expect(201)
      ).body,
    );
    expect(waste).toMatchObject({ kind: 'adjustment', reason: 'waste', value: '-4.50' });
    expect(waste.number).toMatch(/^ADJ-/);
    // 4.5 kg left, reorder level 5 → low.
    expect((await stockOf(s.owner, s.main)).Tomatoes).toEqual(['4.500', '3.0000', '13.50', true]);

    const short = await post(s.owner, '/adjustments', {
      warehouseId: s.main,
      reason: 'breakage',
      lines: [{ itemId: s.tomatoes, quantity: '-10' }],
    }).expect(409);
    expect(short.body).toMatchObject({
      code: 'inventory.insufficient_stock',
      details: { itemIds: [s.tomatoes] },
    });
    await putSetting(s.owner, 'inventory.allowNegativeStock', true).expect(200);
    await post(s.owner, '/adjustments', {
      warehouseId: s.main,
      reason: 'breakage',
      lines: [{ itemId: s.tomatoes, quantity: '-10' }],
    }).expect(201);
    expect((await stockOf(s.owner, s.main)).Tomatoes?.[0]).toBe('-5.500');
  });

  it('transfers stock with its cost, also to another location', async () => {
    const s = await setup();
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.cola, quantity: '24', unitCost: '0.5' }],
    }).expect(201);
    await post(s.owner, '/receipts', {
      warehouseId: s.bar,
      lines: [{ itemId: s.cola, quantity: '6', unitCost: '0.8' }],
    }).expect(201);
    const moved = stockDocumentSchema.parse(
      (
        await post(s.owner, '/transfers', {
          fromWarehouseId: s.main,
          toWarehouseId: s.bar,
          lines: [{ itemId: s.cola, quantity: '12' }],
        }).expect(201)
      ).body,
    );
    expect(moved).toMatchObject({ kind: 'transfer', toWarehouseName: 'Bar', value: '-6.00' });
    expect(moved.lines.map((l) => [l.warehouseId, l.quantity, l.unitCost])).toEqual([
      [s.main, '-12.000', '0.5000'],
      [s.bar, '12.000', '0.5000'],
    ]);
    expect((await stockOf(s.owner, s.main))['Cola 0.33']).toEqual([
      '12.000',
      '0.5000',
      '6.00',
      false,
    ]);
    // 6 at 0.80 + 12 at 0.50 = 10.80 for 18 → 0.6
    expect((await stockOf(s.owner, s.bar))['Cola 0.33']).toEqual([
      '18.000',
      '0.6000',
      '10.80',
      false,
    ]);

    await post(s.owner, '/transfers', {
      fromWarehouseId: s.bar,
      toWarehouseId: s.far,
      lines: [{ itemId: s.cola, quantity: '3' }],
    }).expect(201);
    expect((await stockOf(s.owner, s.far))['Cola 0.33']?.[0]).toBe('3.000');
    const same = await post(s.owner, '/transfers', {
      fromWarehouseId: s.bar,
      toWarehouseId: s.bar,
      lines: [{ itemId: s.cola, quantity: '1' }],
    }).expect(400);
    expect(same.body).toMatchObject({ code: 'inventory.same_warehouse' });
  });

  it('keeps the levels equal to the ledger', async () => {
    const s = await setup();
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [
        { itemId: s.tomatoes, quantity: '7.25', unitCost: '1.1' },
        { itemId: s.cola, quantity: '10', unitCost: '0.4' },
      ],
    }).expect(201);
    await post(s.owner, '/adjustments', {
      warehouseId: s.main,
      reason: 'count',
      lines: [{ itemId: s.tomatoes, quantity: '0.75' }],
    }).expect(201);
    await post(s.owner, '/transfers', {
      fromWarehouseId: s.main,
      toWarehouseId: s.bar,
      lines: [{ itemId: s.cola, quantity: '4' }],
    }).expect(201);
    const [ledger, levels] = await seed.as(s.org.id, async (db) => [
      await db.$queryRaw<{ warehouse_id: string; item_id: string; q: string }[]>`
        SELECT warehouse_id::text, item_id::text, sum(quantity)::numeric(14,3)::text AS q
        FROM stock_movements GROUP BY 1, 2 ORDER BY 1, 2`,
      await db.$queryRaw<{ warehouse_id: string; item_id: string; q: string }[]>`
        SELECT warehouse_id::text, item_id::text, quantity::text AS q
        FROM stock_levels WHERE quantity <> 0 ORDER BY 1, 2`,
    ]);
    expect(levels).toEqual(ledger);
  });

  it('replays a repeated document instead of booking it twice; audits it without notes', async () => {
    const s = await setup();
    const key = uuidv7();
    const body = {
      warehouseId: s.main,
      supplier: 'Secret Supplier',
      note: 'private note',
      lines: [{ itemId: s.tomatoes, quantity: '2', unitCost: '1' }],
    };
    const first = (await post(s.owner, '/receipts', body, key).expect(201)).body as { id: string };
    const again = (await post(s.owner, '/receipts', body, key).expect(201)).body as { id: string };
    expect(again.id).toBe(first.id);
    expect((await stockOf(s.owner, s.main)).Tomatoes?.[0]).toBe('2.000');
    const rows = await seed.as(s.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'inventory.stock_document.created' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({ kind: 'receipt', lineCount: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/Secret Supplier|private note/);
  });

  it('refuses archived or unknown items and warehouses, and FIFO organizations', async () => {
    const s = await setup();
    await patch(s.owner, `/items/${s.cola}`, { archived: true }).expect(200);
    const archived = await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.cola, quantity: '1', unitCost: '1' }],
    }).expect(404);
    expect(archived.body).toMatchObject({
      code: 'inventory.item_not_found',
      details: { itemIds: [s.cola] },
    });
    await patch(s.owner, `/warehouses/${s.bar}`, { archived: true }).expect(200);
    await post(s.owner, '/receipts', {
      warehouseId: s.bar,
      lines: [{ itemId: s.tomatoes, quantity: '1', unitCost: '1' }],
    }).expect(404);
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [
        { itemId: s.tomatoes, quantity: '1', unitCost: '1' },
        { itemId: s.tomatoes, quantity: '2', unitCost: '1' },
      ],
    }).expect(400);
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.tomatoes, quantity: '0', unitCost: '1' }],
    }).expect(400);

    await putSetting(s.owner, 'inventory.valuationMethod', 'fifo').expect(200);
    const fifo = await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.tomatoes, quantity: '1', unitCost: '1' }],
    }).expect(409);
    expect(fifo.body).toMatchObject({ code: 'inventory.valuation_unsupported' });
  });

  it('keeps names unique among active rows and locks the unit once moved', async () => {
    const s = await setup();
    await post(s.owner, '/items', { name: 'Tomatoes', unit: 'kg' }).expect(409);
    await post(s.owner, '/warehouses', { locationId: s.org.locations[0], name: 'Bar' }).expect(409);
    // The same name is fine at another location.
    await post(s.owner, '/warehouses', { locationId: s.org.locations[1], name: 'Bar' }).expect(201);
    await patch(s.owner, `/items/${s.cola}`, { unit: 'l' }).expect(200);
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.tomatoes, quantity: '1', unitCost: '1' }],
    }).expect(201);
    const locked = await patch(s.owner, `/items/${s.tomatoes}`, { unit: 'g' }).expect(409);
    expect(locked.body).toMatchObject({ code: 'inventory.unit_locked' });
    await patch(s.owner, `/items/${s.tomatoes}`, { minQuantity: '2.5', sku: 'TOM-1' }).expect(200);
  });

  it('lists documents newest first and shows one with its lines', async () => {
    const s = await setup();
    await post(s.owner, '/receipts', {
      warehouseId: s.main,
      lines: [{ itemId: s.cola, quantity: '5', unitCost: '1' }],
    }).expect(201);
    const adjustment = stockDocumentSchema.parse(
      (
        await post(s.owner, '/adjustments', {
          warehouseId: s.main,
          reason: 'other',
          lines: [{ itemId: s.cola, quantity: '-1' }],
        }).expect(201)
      ).body,
    );
    const list = stockDocumentListResponseSchema.parse(
      (await get(s.owner, `/documents?warehouseId=${s.main}`).expect(200)).body,
    );
    expect(list.data.map((d) => d.kind)).toEqual(['adjustment', 'receipt']);
    const one = stockDocumentSchema.parse(
      (await get(s.owner, `/documents/${adjustment.id}`).expect(200)).body,
    );
    expect(one.lines).toMatchObject([{ itemName: 'Cola 0.33', unit: 'pc', quantity: '-1.000' }]);
  });

  it('gives each role what the spec says, at its locations', async () => {
    const s = await setup();
    const cook = await memberToken(s.org, 'kitchen', [s.org.locations[0]]);
    const waiter = await memberToken(s.org, 'waiter');
    const staff = await memberToken(s.org, 'staff');
    const manager = await memberToken(s.org, 'manager');
    const receipt = (warehouseId: string) => ({
      warehouseId,
      lines: [{ itemId: s.tomatoes, quantity: '1', unitCost: '1' }],
    });
    await post(cook, '/receipts', receipt(s.main)).expect(201);
    await post(cook, '/adjustments', {
      warehouseId: s.main,
      reason: 'waste',
      lines: [{ itemId: s.tomatoes, quantity: '-1' }],
    }).expect(201);
    // Not their location: it doesn't exist for them.
    await post(cook, '/receipts', receipt(s.far)).expect(404);
    await post(cook, '/transfers', {
      fromWarehouseId: s.main,
      toWarehouseId: s.bar,
      lines: [{ itemId: s.tomatoes, quantity: '1' }],
    }).expect(403);
    await post(cook, '/items', { name: 'Salt', unit: 'kg' }).expect(403);
    const visible = warehouseListResponseSchema.parse(
      (await get(cook, '/warehouses').expect(200)).body,
    );
    expect(visible.data.map((w) => w.name).sort()).toEqual(['Bar', 'Main store']);
    await get(waiter, '/stock').expect(403);
    await get(staff, '/stock').expect(200);
    await post(staff, '/receipts', receipt(s.main)).expect(403);
    await post(manager, '/warehouses', {
      locationId: s.org.locations[0],
      name: 'Cold room',
    }).expect(201);
    await post(manager, '/items', { name: 'Salt', unit: 'kg' }).expect(403);
  });

  it('needs the inventory feature', async () => {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    await get(owner, '/stock').expect(200);
    await entitlements.setOverride(org.id, 'inventory', false, undefined, 'cli.entitlements');
    await get(owner, '/stock').expect(403);
  });

  it("never shows or books another organization's warehouses, items and documents", async () => {
    const a = await setup();
    const b = await setup();
    const doc = stockDocumentSchema.parse(
      (
        await post(a.owner, '/receipts', {
          warehouseId: a.main,
          lines: [{ itemId: a.cola, quantity: '1', unitCost: '1' }],
        }).expect(201)
      ).body,
    );
    await post(b.owner, '/receipts', {
      warehouseId: a.main,
      lines: [{ itemId: b.cola, quantity: '1', unitCost: '1' }],
    }).expect(404);
    await post(b.owner, '/receipts', {
      warehouseId: b.main,
      lines: [{ itemId: a.cola, quantity: '1', unitCost: '1' }],
    }).expect(404);
    await get(b.owner, `/documents/${doc.id}`).expect(404);
    await patch(b.owner, `/items/${a.cola}`, { name: 'Mine' }).expect(404);
    await patch(b.owner, `/warehouses/${a.main}`, { name: 'Mine' }).expect(404);
    const stock = stockLevelListResponseSchema.parse(
      (await get(b.owner, '/stock').expect(200)).body,
    );
    expect(stock.data).toEqual([]);
    expect((await stockOf(a.owner, a.main))['Cola 0.33']?.[0]).toBe('1.000');
  });
});
