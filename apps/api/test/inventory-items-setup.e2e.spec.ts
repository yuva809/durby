import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  bomListResponseSchema,
  bomSchema,
  generateVariantsResponseSchema,
  stockDocumentSchema,
  stockItemListResponseSchema,
  stockItemSchema,
  stockLevelListResponseSchema,
  type SystemRole,
  unitOfMeasureListResponseSchema,
  unitOfMeasureSchema,
  variantAttributeListResponseSchema,
  variantAttributeSchema,
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
 * docs/modules/inventory.md → Step 5 (ADR 0038): units of measurement, variant attributes and variants, bills of
 * materials and production orders. Route keys: units, attributes and variants on inventory.items.*, bills on
 * inventory.recipes.*, production on inventory.stock.produce.
 */
describe('inventory items setup (ADR 0038)', () => {
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

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) =>
    auth(request(server).get(`/api/v1/inventory${path}`), token);
  const send = (
    method: 'post' | 'patch' | 'put' | 'delete',
    token: string,
    path: string,
    body?: unknown,
  ) =>
    withIdempotencyKey(
      auth(request(server)[method](`/api/v1/inventory${path}`), token),
      uuidv7(),
    ).send(body ?? {});
  const post = (token: string, path: string, body: unknown) => send('post', token, path, body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const main = warehouseSchema.parse(
      (await post(owner, '/warehouses', { locationId: org.locations[0], name: 'Main' }).expect(201))
        .body,
    ).id;
    const item = async (name: string, unit: string) =>
      stockItemSchema.parse((await post(owner, '/items', { name, unit }).expect(201)).body).id;
    return { org, owner, main, item };
  }

  const levels = async (token: string, warehouseId: string) =>
    Object.fromEntries(
      stockLevelListResponseSchema
        .parse((await get(token, `/stock?warehouseId=${warehouseId}`).expect(200)).body)
        .data.map((l) => [l.itemName, [l.quantity, l.averageCost]]),
    );

  describe('units of measurement', () => {
    it('converts a receipt entered in cases into pieces at the cost per piece', async () => {
      const s = await setup();
      const cola = await s.item('Cola', 'pc');
      const tomatoes = await s.item('Tomatoes', 'kg');
      const unit = unitOfMeasureSchema.parse(
        (
          await post(s.owner, '/units', {
            name: 'Case',
            symbol: 'cs',
            baseUnit: 'pc',
            factor: '24',
          }).expect(201)
        ).body,
      );
      expect(unit).toMatchObject({ name: 'Case', baseUnit: 'pc', factor: '24.000000' });

      const receipt = stockDocumentSchema.parse(
        (
          await post(s.owner, '/receipts', {
            warehouseId: s.main,
            lines: [{ itemId: cola, quantity: '2', unitCost: '12', unitId: unit.id }],
          }).expect(201)
        ).body,
      );
      expect(receipt.lines[0]).toMatchObject({
        quantity: '48.000',
        unitCost: '0.5000',
        value: '24.00',
      });

      // A case of pieces doesn't fit an item in kg.
      const mismatch = await post(s.owner, '/receipts', {
        warehouseId: s.main,
        lines: [{ itemId: tomatoes, quantity: '1', unitCost: '1', unitId: unit.id }],
      }).expect(400);
      expect(mismatch.body).toMatchObject({ code: 'inventory.unit_mismatch' });
    });

    it('keeps names unique among active units, and archives instead of deleting', async () => {
      const s = await setup();
      const body = { name: 'Sack', symbol: 'sk', baseUnit: 'kg', factor: '25' };
      const sack = unitOfMeasureSchema.parse(
        (await post(s.owner, '/units', body).expect(201)).body,
      );
      expect((await post(s.owner, '/units', body).expect(409)).body).toMatchObject({
        code: 'inventory.unit_name_taken',
      });
      await send('patch', s.owner, `/units/${sack.id}`, { archived: true }).expect(200);
      expect(
        unitOfMeasureListResponseSchema.parse((await get(s.owner, '/units').expect(200)).body).data,
      ).toEqual([]);
      await post(s.owner, '/units', body).expect(201);
    });

    it('is item setup: managers read units but cannot create them', async () => {
      const s = await setup();
      const manager = await memberToken(s.org, 'manager');
      await get(manager, '/units').expect(200);
      await post(manager, '/units', {
        name: 'Box',
        symbol: 'bx',
        baseUnit: 'pc',
        factor: '6',
      }).expect(403);
    });
  });

  describe('variant attributes and variants', () => {
    it('generates every combination once, as stock items in the parent unit', async () => {
      const s = await setup();
      const shirt = await s.item('Shirt', 'pc');
      const size = variantAttributeSchema.parse(
        (await post(s.owner, '/attributes', { name: 'Size', values: ['S', 'M', 'L'] }).expect(201))
          .body,
      );
      const colour = variantAttributeSchema.parse(
        (
          await post(s.owner, '/attributes', { name: 'Colour', values: ['Red', 'Blue'] }).expect(
            201,
          )
        ).body,
      );
      const first = generateVariantsResponseSchema.parse(
        (
          await post(s.owner, `/items/${shirt}/variants`, {
            attributes: [
              { attributeId: size.id, values: ['L', 'S'] },
              { attributeId: colour.id, values: ['Blue'] },
            ],
            skuPrefix: 'SH',
          }).expect(201)
        ).body,
      );
      // Values in the attribute's order (S before L), not the order picked.
      expect(first.created.map((v) => [v.name, v.sku, v.unit, v.variantValues])).toEqual([
        ['Shirt · S / Blue', 'SH-1', 'pc', ['S', 'Blue']],
        ['Shirt · L / Blue', 'SH-2', 'pc', ['L', 'Blue']],
      ]);
      expect(first.created.every((v) => v.parentItemId === shirt)).toBe(true);

      const again = generateVariantsResponseSchema.parse(
        (
          await post(s.owner, `/items/${shirt}/variants`, {
            attributes: [
              { attributeId: size.id, values: ['S', 'M', 'L'] },
              { attributeId: colour.id, values: ['Blue'] },
            ],
          }).expect(201)
        ).body,
      );
      expect(again).toMatchObject({ skipped: 2 });
      expect(again.created.map((v) => v.variantValues)).toEqual([['M', 'Blue']]);

      // The parent holds no stock once it has variants; its variants do.
      expect(
        (
          await post(s.owner, '/receipts', {
            warehouseId: s.main,
            lines: [{ itemId: shirt, quantity: '1', unitCost: '5' }],
          }).expect(409)
        ).body,
      ).toMatchObject({ code: 'inventory.item_has_variants' });
      await post(s.owner, '/receipts', {
        warehouseId: s.main,
        lines: [{ itemId: first.created[0]!.id, quantity: '3', unitCost: '5' }],
      }).expect(201);

      // A variant cannot have variants.
      await post(s.owner, `/items/${first.created[0]!.id}/variants`, {
        attributes: [{ attributeId: colour.id, values: ['Red'] }],
      }).expect(409);

      const items = stockItemListResponseSchema.parse(
        (await get(s.owner, '/items').expect(200)).body,
      );
      expect(items.data.filter((i) => i.parentItemId === shirt)).toHaveLength(3);
    });

    it('refuses values the attribute does not have, and items that already hold stock', async () => {
      const s = await setup();
      const cola = await s.item('Cola', 'pc');
      const pack = variantAttributeSchema.parse(
        (
          await post(s.owner, '/attributes', { name: 'Pack', values: ['0.33 l', '0.5 l'] }).expect(
            201,
          )
        ).body,
      );
      await post(s.owner, `/items/${cola}/variants`, {
        attributes: [{ attributeId: pack.id, values: ['1 l'] }],
      }).expect(404);
      await post(s.owner, '/receipts', {
        warehouseId: s.main,
        lines: [{ itemId: cola, quantity: '1', unitCost: '1' }],
      }).expect(201);
      expect(
        (
          await post(s.owner, `/items/${cola}/variants`, {
            attributes: [{ attributeId: pack.id, values: ['0.5 l'] }],
          }).expect(409)
        ).body,
      ).toMatchObject({ code: 'inventory.variant_not_allowed' });
    });
  });

  describe('bills of materials and production orders', () => {
    async function sauce() {
      const s = await setup();
      const tomatoes = await s.item('Tomatoes', 'kg');
      const oil = await s.item('Oil', 'l');
      const sauceItem = await s.item('Tomato sauce', 'l');
      await post(s.owner, '/receipts', {
        warehouseId: s.main,
        lines: [
          { itemId: tomatoes, quantity: '10', unitCost: '2' },
          { itemId: oil, quantity: '2', unitCost: '8' },
        ],
      }).expect(201);
      const bill = bomSchema.parse(
        (
          await send('put', s.owner, `/boms/${sauceItem}`, {
            outputQuantity: '1',
            lines: [
              { itemId: tomatoes, quantity: '2' },
              { itemId: oil, quantity: '0.1' },
            ],
          }).expect(200)
        ).body,
      );
      return { ...s, tomatoes, oil, sauceItem, bill };
    }

    it('keeps one bill per item, replaced as a whole, and refuses an item in its own bill', async () => {
      const s = await sauce();
      expect(s.bill).toMatchObject({ itemName: 'Tomato sauce', outputQuantity: '1.000' });
      expect(s.bill.lines.map((l) => [l.itemName, l.quantity])).toEqual([
        ['Oil', '0.100'],
        ['Tomatoes', '2.000'],
      ]);
      await send('put', s.owner, `/boms/${s.sauceItem}`, {
        outputQuantity: '2',
        lines: [{ itemId: s.tomatoes, quantity: '4' }],
      }).expect(200);
      const list = bomListResponseSchema.parse((await get(s.owner, '/boms').expect(200)).body);
      expect(list.data).toHaveLength(1);
      expect(list.data[0]!.lines).toHaveLength(1);
      expect(
        (
          await send('put', s.owner, `/boms/${s.sauceItem}`, {
            outputQuantity: '1',
            lines: [{ itemId: s.sauceItem, quantity: '1' }],
          }).expect(400)
        ).body,
      ).toMatchObject({ code: 'inventory.bom_invalid' });
      await send('delete', s.owner, `/boms/${s.sauceItem}`).expect(204);
      await get(s.owner, `/boms/${s.sauceItem}`).expect(404);
    });

    it('takes the components out at average cost and books the item in at their value', async () => {
      const s = await sauce();
      const year = new Date().getUTCFullYear();
      const order = stockDocumentSchema.parse(
        (
          await post(s.owner, '/productions', {
            warehouseId: s.main,
            itemId: s.sauceItem,
            quantity: '3',
          }).expect(201)
        ).body,
      );
      expect(order).toMatchObject({ kind: 'production', number: `PRD-${year}-000001` });
      // 6 kg tomatoes at 2 = 12.00, 0.3 l oil at 8 = 2.40 → 14.40 for 3 l → 4.8 per l.
      expect(await levels(s.owner, s.main)).toEqual({
        Oil: ['1.700', '8.0000'],
        'Tomato sauce': ['3.000', '4.8000'],
        Tomatoes: ['4.000', '2.0000'],
      });
      expect(
        (
          await post(s.owner, '/productions', {
            warehouseId: s.main,
            itemId: s.sauceItem,
            quantity: '10',
          }).expect(409)
        ).body,
      ).toMatchObject({ code: 'inventory.insufficient_stock' });
    });

    it('lets the kitchen produce, not staff, and needs a bill', async () => {
      const s = await sauce();
      const kitchen = await memberToken(s.org, 'kitchen');
      const staff = await memberToken(s.org, 'staff');
      const body = { warehouseId: s.main, itemId: s.sauceItem, quantity: '1' };
      await post(staff, '/productions', body).expect(403);
      await post(kitchen, '/productions', body).expect(201);
      expect(
        (await post(s.owner, '/productions', { ...body, itemId: s.oil }).expect(404)).body,
      ).toMatchObject({ code: 'inventory.bom_not_found' });
    });
  });

  it("never shows another organization's units, attributes or bills", async () => {
    const a = await setup();
    const b = await setup();
    const unit = unitOfMeasureSchema.parse(
      (
        await post(a.owner, '/units', {
          name: 'Case',
          symbol: 'cs',
          baseUnit: 'pc',
          factor: '12',
        }).expect(201)
      ).body,
    );
    const attribute = variantAttributeSchema.parse(
      (await post(a.owner, '/attributes', { name: 'Size', values: ['S'] }).expect(201)).body,
    );
    const output = await a.item('Dough', 'kg');
    const flour = await a.item('Flour', 'kg');
    await send('put', a.owner, `/boms/${output}`, {
      outputQuantity: '1',
      lines: [{ itemId: flour, quantity: '1' }],
    }).expect(200);

    expect(
      unitOfMeasureListResponseSchema.parse((await get(b.owner, '/units').expect(200)).body).data,
    ).toEqual([]);
    expect(
      variantAttributeListResponseSchema.parse((await get(b.owner, '/attributes').expect(200)).body)
        .data,
    ).toEqual([]);
    expect(
      bomListResponseSchema.parse((await get(b.owner, '/boms').expect(200)).body).data,
    ).toEqual([]);
    await get(b.owner, `/boms/${output}`).expect(404);
    await send('patch', b.owner, `/units/${unit.id}`, { name: 'Mine' }).expect(404);
    await send('patch', b.owner, `/attributes/${attribute.id}`, { name: 'Mine' }).expect(404);
    const cola = await b.item('Cola', 'pc');
    await post(b.owner, '/receipts', {
      warehouseId: b.main,
      lines: [{ itemId: cola, quantity: '1', unitCost: '1', unitId: unit.id }],
    }).expect(404);
  });
});
