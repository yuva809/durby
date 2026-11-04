import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  dishCostListResponseSchema,
  type EventType,
  productCategorySchema,
  productSchema,
  recipeSchema,
  sendTicketResponseSchema,
  stockDocumentListResponseSchema,
  stockDocumentSchema,
  stockItemSchema,
  stockLevelListResponseSchema,
  type SystemRole,
  warehouseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ConsumptionHandler } from '../src/modules/inventory/consumption.handler';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { type OutboxEvent, OutboxEventRunner, type RunOutcome } from '../src/platform/outbox';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../src/platform/tenancy';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/inventory.md → Step 2 (ADR 0028): recipes, dish costs and the consumption of
 * table-service sales through pos.kitchen_ticket.created, delivered with the outbox's runner.
 */
describe('inventory recipes and sales consumption', () => {
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

  async function memberToken(org: SeededOrg, role: SystemRole) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const send = (method: 'post' | 'put' | 'patch', token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server)[method](`/api/v1${path}`).auth(token, { type: 'bearer' }),
    ).send(body as object);

  /**
   * Soup (kitchen) and beer (bar) on the menu, tomatoes, cream and beer in stock: a kitchen store
   * and a bar store at location 1, each marked as supplying its station.
   */
  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const here = org.locations[0];
    const category = async (name: string, station: string) =>
      productCategorySchema.parse(
        (await send('post', owner, '/catalog/categories', { name, station }).expect(201)).body,
      ).id;
    const product = async (categoryId: string, name: string, price: string, taxRate: string) =>
      productSchema.parse(
        (
          await send('post', owner, '/catalog/products', {
            categoryId,
            name,
            price,
            taxRate,
          }).expect(201)
        ).body,
      ).id;
    const soup = await product(await category('Food', 'kitchen'), 'Soup', '10.70', '7');
    const beerDish = await product(await category('Drinks', 'bar'), 'Beer 0.5', '4.76', '19');
    const warehouse = async (name: string, station: string) => {
      const w = warehouseSchema.parse(
        (await send('post', owner, '/inventory/warehouses', { locationId: here, name }).expect(201))
          .body,
      ).id;
      await send('patch', owner, `/inventory/warehouses/${w}`, { suppliesStation: station }).expect(
        200,
      );
      return w;
    };
    const kitchen = await warehouse('Kitchen store', 'kitchen');
    const bar = await warehouse('Bar store', 'bar');
    const item = async (name: string, unit: string) =>
      stockItemSchema.parse(
        (await send('post', owner, '/inventory/items', { name, unit }).expect(201)).body,
      ).id;
    const tomatoes = await item('Tomatoes', 'kg');
    const cream = await item('Cream', 'l');
    const beer = await item('Beer keg', 'l');
    await send('post', owner, '/inventory/receipts', {
      warehouseId: kitchen,
      lines: [
        { itemId: tomatoes, quantity: '10', unitCost: '2' },
        { itemId: cream, quantity: '2', unitCost: '4' },
      ],
    }).expect(201);
    await send('post', owner, '/inventory/receipts', {
      warehouseId: bar,
      lines: [{ itemId: beer, quantity: '50', unitCost: '1.6' }],
    }).expect(201);
    const table = diningTableSchema.parse(
      (
        await send('post', owner, '/pos/tables', { locationId: here, name: 'T1', seats: 4 }).expect(
          201,
        )
      ).body,
    ).id;
    return { org, owner, here, soup, beerDish, kitchen, bar, tomatoes, cream, beer, table };
  }
  type Restaurant = Awaited<ReturnType<typeof restaurant>>;

  const putRecipe = (r: Restaurant, productId: string, lines: unknown[], token = r.owner) =>
    send('put', token, `/inventory/recipes/${productId}`, { lines });

  async function withRecipes(r: Restaurant) {
    // A soup: 0.3 kg tomatoes and 0.05 l cream → 0.60 + 0.20 = 0.80. A beer: 0.5 l → 0.80.
    await putRecipe(r, r.soup, [
      { itemId: r.tomatoes, quantity: '0.3' },
      { itemId: r.cream, quantity: '0.05' },
    ]).expect(200);
    await putRecipe(r, r.beerDish, [{ itemId: r.beer, quantity: '0.5' }]).expect(200);
  }

  const events = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.outboxEvent.findMany({
        where: { type: 'pos.kitchen_ticket.created' },
        orderBy: { id: 'asc' },
        select: { id: true, type: true, version: true, payload: true, occurredAt: true },
      }),
    );
  /** Delivers every ticket event to inventory, like the worker would. */
  async function deliver(orgId: string): Promise<RunOutcome[]> {
    const runner = app.get(OutboxEventRunner);
    const outcomes: RunOutcome[] = [];
    for (const e of await events(orgId)) {
      outcomes.push(
        await runner.run({
          eventId: e.id,
          tenantId: orgId,
          type: e.type as EventType,
          version: e.version,
          payload: e.payload as Record<string, unknown>,
          occurredAt: e.occurredAt.toISOString(),
          handler: 'inventory.consumeTicket',
        }),
      );
    }
    return outcomes;
  }
  /** Calls the handler directly, past processed_events: what a re-sent event after cleanup does. */
  async function redeliverLast(orgId: string) {
    const handler = app.get(ConsumptionHandler);
    const db = app.get<TenantPrismaClient>(TENANT_PRISMA);
    const [e] = (await events(orgId)).slice(-1);
    const event: OutboxEvent = {
      id: e!.id,
      tenantId: orgId,
      type: e!.type as EventType,
      version: e!.version,
      payload: e!.payload as Record<string, unknown>,
      occurredAt: e!.occurredAt,
    };
    await app
      .get(TenantContext)
      .run({ tenantId: orgId, userId: uuidv7() }, () =>
        db.$transaction((tx) => handler.consumeTicket(event, tx)),
      );
  }

  const level = async (r: Restaurant, warehouseId: string, itemName: string) =>
    stockLevelListResponseSchema
      .parse((await get(r.owner, `/inventory/stock?warehouseId=${warehouseId}`).expect(200)).body)
      .data.find((l) => l.itemName === itemName)?.quantity;
  const sendItems = async (r: Restaurant, lines: unknown[]) =>
    sendTicketResponseSchema.parse(
      (await send('post', r.owner, `/pos/tables/${r.table}/tickets`, { lines }).expect(201)).body,
    );

  describe('recipes', () => {
    it('replaces a recipe, reads it back with names and units, and audits real changes only', async () => {
      const r = await restaurant();
      const recipe = recipeSchema.parse(
        (
          await putRecipe(r, r.soup, [
            { itemId: r.tomatoes, quantity: '0.3' },
            { itemId: r.cream, quantity: '0.05' },
          ]).expect(200)
        ).body,
      );
      expect(recipe.lines).toEqual([
        { itemId: r.cream, itemName: 'Cream', unit: 'l', quantity: '0.050' },
        { itemId: r.tomatoes, itemName: 'Tomatoes', unit: 'kg', quantity: '0.300' },
      ]);
      await putRecipe(r, r.soup, [
        { itemId: r.cream, quantity: '0.050' },
        { itemId: r.tomatoes, quantity: '0.3' },
      ]).expect(200);
      await putRecipe(r, r.soup, [{ itemId: r.tomatoes, quantity: '0.25' }]).expect(200);
      const read = recipeSchema.parse(
        (await get(r.owner, `/inventory/recipes/${r.soup}`).expect(200)).body,
      );
      expect(read.lines.map((l) => [l.itemName, l.quantity])).toEqual([['Tomatoes', '0.250']]);
      const audits = await seed.as(r.org.id, (db) =>
        db.auditLog.findMany({
          where: { action: 'inventory.recipe.updated' },
          orderBy: { id: 'asc' },
        }),
      );
      expect(audits.map((a) => a.after)).toMatchObject([{ lineCount: 2 }, { lineCount: 1 }]);
    });

    it('refuses unknown products and items, duplicates and bad quantities', async () => {
      const r = await restaurant();
      const unknown = await putRecipe(r, uuidv7(), []).expect(404);
      expect(unknown.body).toMatchObject({ code: 'inventory.product_not_found' });
      await putRecipe(r, r.soup, [{ itemId: uuidv7(), quantity: '1' }]).expect(404);
      await putRecipe(r, r.soup, [
        { itemId: r.cream, quantity: '1' },
        { itemId: r.cream, quantity: '2' },
      ]).expect(400);
      await putRecipe(r, r.soup, [{ itemId: r.cream, quantity: '0' }]).expect(400);
    });

    it('lets managers edit recipes and see costs; staff and kitchen read recipes only', async () => {
      const r = await restaurant();
      const manager = await memberToken(r.org, 'manager');
      const cook = await memberToken(r.org, 'kitchen');
      await putRecipe(r, r.soup, [{ itemId: r.tomatoes, quantity: '0.3' }], manager).expect(200);
      await get(manager, '/inventory/costs').expect(200);
      await putRecipe(r, r.soup, [], cook).expect(403);
      await get(cook, `/inventory/recipes/${r.soup}`).expect(200);
      await get(cook, '/inventory/costs').expect(403);
    });

    it("never reads or writes another organization's recipes", async () => {
      const a = await restaurant();
      const b = await restaurant();
      await withRecipes(a);
      await get(b.owner, `/inventory/recipes/${a.soup}`).expect(404);
      await putRecipe(b, a.soup, []).expect(404);
      await putRecipe(b, b.soup, [{ itemId: a.tomatoes, quantity: '1' }]).expect(404);
      const costs = dishCostListResponseSchema.parse(
        (await get(b.owner, '/inventory/costs').expect(200)).body,
      );
      expect(costs.data).toEqual([]);
    });

    it('still lets the bulk delete remove a never-sold product that has a recipe', async () => {
      const r = await restaurant();
      await withRecipes(r);
      const res = await send('post', r.owner, '/catalog/products/bulk', {
        ids: [r.soup],
        action: { kind: 'delete' },
      }).expect(200);
      expect(res.body).toMatchObject({ deleted: [r.soup], kept: [] });
      const costs = dishCostListResponseSchema.parse(
        (await get(r.owner, '/inventory/costs').expect(200)).body,
      );
      expect(costs.data.map((c) => c.productId)).toEqual([r.beerDish]);
    });
  });

  describe('dish costs', () => {
    it('costs each dish from its recipe and the current costs', async () => {
      const r = await restaurant();
      await withRecipes(r);
      const costs = dishCostListResponseSchema.parse(
        (await get(r.owner, '/inventory/costs').expect(200)).body,
      );
      const byProduct = new Map(costs.data.map((c) => [c.productId, c]));
      expect(byProduct.get(r.soup)).toMatchObject({ cost: '0.80', complete: true });
      expect(byProduct.get(r.beerDish)).toMatchObject({ cost: '0.80', complete: true });
    });

    it('averages an item over warehouses with stock, and is incomplete without a cost', async () => {
      const r = await restaurant();
      // 10 kg at 2.00 in the kitchen, 10 kg at 4.00 in the bar store → 3.00.
      await send('post', r.owner, '/inventory/receipts', {
        warehouseId: r.bar,
        lines: [{ itemId: r.tomatoes, quantity: '10', unitCost: '4' }],
      }).expect(201);
      const salt = stockItemSchema.parse(
        (await send('post', r.owner, '/inventory/items', { name: 'Salt', unit: 'g' }).expect(201))
          .body,
      ).id;
      await putRecipe(r, r.soup, [
        { itemId: r.tomatoes, quantity: '0.5' },
        { itemId: salt, quantity: '5' },
      ]).expect(200);
      const [soup] = dishCostListResponseSchema.parse(
        (await get(r.owner, '/inventory/costs').expect(200)).body,
      ).data;
      expect(soup).toMatchObject({ cost: '1.50', complete: false });
      expect(soup!.lines.find((l) => l.itemId === salt)?.unitCost).toBeNull();
    });
  });

  describe('consumption from sales', () => {
    it("takes a sale's ingredients from the station's warehouse, kitchen and bar apart", async () => {
      const r = await restaurant();
      await withRecipes(r);
      await sendItems(r, [
        { productId: r.soup, quantity: 2 },
        { productId: r.beerDish, quantity: 3 },
      ]);
      expect(await deliver(r.org.id)).toEqual(['applied', 'applied']);
      expect(await level(r, r.kitchen, 'Tomatoes')).toBe('9.400');
      expect(await level(r, r.kitchen, 'Cream')).toBe('1.900');
      expect(await level(r, r.bar, 'Beer keg')).toBe('48.500');
      const docs = stockDocumentListResponseSchema.parse(
        (await get(r.owner, '/inventory/documents?kind=consumption').expect(200)).body,
      ).data;
      expect(docs.map((d) => [d.warehouseName, d.value])).toEqual([
        ['Bar store', '-2.40'],
        ['Kitchen store', '-1.60'],
      ]);
      expect(docs[0]!.number).toMatch(/^CON-/);
    });

    it('puts voided dishes back, and a redelivered event books nothing twice', async () => {
      const r = await restaurant();
      await withRecipes(r);
      const { order } = await sendItems(r, [{ productId: r.soup, quantity: 2 }]);
      await send('post', r.owner, `/pos/orders/${order.id}/voids`, {
        lines: [{ lineId: order.tickets[0]!.lines[0]!.id, quantity: 1 }],
      }).expect(201);
      expect(await deliver(r.org.id)).toEqual(['applied', 'applied']);
      expect(await deliver(r.org.id)).toEqual(['duplicate', 'duplicate']);
      await redeliverLast(r.org.id);
      expect(await level(r, r.kitchen, 'Tomatoes')).toBe('9.700');
      const docs = stockDocumentListResponseSchema.parse(
        (await get(r.owner, '/inventory/documents?kind=consumption').expect(200)).body,
      ).data;
      expect(docs).toHaveLength(2);
      const back = stockDocumentSchema.parse(
        (await get(r.owner, `/inventory/documents/${docs[0]!.id}`).expect(200)).body,
      );
      expect(back.lines.find((l) => l.itemName === 'Tomatoes')?.quantity).toBe('0.300');
    });

    it('goes below zero for a sale whatever the stock setting says', async () => {
      const r = await restaurant();
      await putRecipe(r, r.soup, [{ itemId: r.cream, quantity: '1' }]).expect(200);
      await sendItems(r, [{ productId: r.soup, quantity: 3 }]);
      await deliver(r.org.id);
      expect(await level(r, r.kitchen, 'Cream')).toBe('-1.000');
    });

    it('books nothing without recipes, and nothing for organizations without inventory', async () => {
      const r = await restaurant();
      await sendItems(r, [{ productId: r.soup, quantity: 1 }]);
      expect(await deliver(r.org.id)).toEqual(['applied']);
      const none = stockDocumentListResponseSchema.parse(
        (await get(r.owner, '/inventory/documents?kind=consumption').expect(200)).body,
      );
      expect(none.data).toEqual([]);

      const s = await restaurant();
      await withRecipes(s);
      await entitlements.setOverride(s.org.id, 'inventory', false, undefined, 'cli.entitlements');
      await sendItems(s, [{ productId: s.soup, quantity: 1 }]);
      await deliver(s.org.id);
      const count = await seed.as(s.org.id, (db) =>
        db.stockDocument.count({ where: { kind: 'consumption' } }),
      );
      expect(count).toBe(0);
    });

    it('falls back to the first warehouse when none supplies the station', async () => {
      const r = await restaurant();
      await withRecipes(r);
      await send('patch', r.owner, `/inventory/warehouses/${r.bar}`, {
        suppliesStation: null,
      }).expect(200);
      await sendItems(r, [{ productId: r.beerDish, quantity: 2 }]);
      await deliver(r.org.id);
      // Bar store sorts before Kitchen store by name.
      expect(await level(r, r.bar, 'Beer keg')).toBe('49.000');
    });

    it('allows one supplier per station and location', async () => {
      const r = await restaurant();
      const res = await send('patch', r.owner, `/inventory/warehouses/${r.bar}`, {
        suppliesStation: 'kitchen',
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'inventory.station_taken' });
    });
  });
});
