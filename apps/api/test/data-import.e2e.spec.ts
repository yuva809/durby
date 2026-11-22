import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  dataImportResultSchema,
  orderCustomerListResponseSchema,
  productCategoryListResponseSchema,
  stockItemListResponseSchema,
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
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * Import Data (docs/platform/import.md, ADR 0044 step 4): categories, stock items, opening stock and customers, each
 * at its module, all rows in one transaction, refused as a whole with the rows' problems.
 */
describe('data import (ADR 0044 step 4)', () => {
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
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const post = (token: string, path: string, body: object, key: string = uuidv7()) =>
    withIdempotencyKey(auth(request(server).post(`/api/v1${path}`), token), key).send(body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    return { org, owner };
  }

  it('adds missing categories at the end and leaves the others', async () => {
    const s = await setup();
    await post(s.owner, '/catalog/categories', { name: 'Rice' }).expect(201);
    const result = dataImportResultSchema.parse(
      (
        await post(s.owner, '/catalog/categories/import', {
          rows: [{ name: 'rice' }, { name: 'Oil' }, { name: 'Snacks' }],
        }).expect(200)
      ).body,
    );
    expect(result).toMatchObject({ created: 2, unchanged: 1 });
    const list = productCategoryListResponseSchema.parse(
      (await get(s.owner, '/catalog/categories').expect(200)).body,
    );
    expect(list.data.map((c) => c.name)).toEqual(['Rice', 'Oil', 'Snacks']);
    await post(s.owner, '/catalog/categories/import', {
      rows: [{ name: 'A' }, { name: 'a' }],
    }).expect(400);
  });

  it('creates and updates stock items by SKU or name, all or nothing', async () => {
    const s = await setup();
    await post(s.owner, '/inventory/items', { name: 'Rice', unit: 'pc', sku: 'R-1' }).expect(201);
    const result = dataImportResultSchema.parse(
      (
        await post(s.owner, '/inventory/items/import', {
          rows: [
            { name: 'Rice 5 kg', sku: 'R-1', unit: 'pc', salePrice: '12.90' },
            { name: 'Oil', unit: 'l', minQuantity: '2' },
          ],
        }).expect(200)
      ).body,
    );
    expect(result).toMatchObject({ created: 1, updated: 1, unchanged: 0 });
    const items = stockItemListResponseSchema.parse(
      (await get(s.owner, '/inventory/items').expect(200)).body,
    );
    expect(items.data.map((i) => [i.name, i.sku, i.salePrice])).toEqual(
      expect.arrayContaining([
        ['Rice 5 kg', 'R-1', '12.90'],
        ['Oil', null, null],
      ]),
    );
    // One bad row: nothing is written.
    const res = await post(s.owner, '/inventory/items/import', {
      rows: [
        { name: 'Sugar', unit: 'kg' },
        { name: 'Salt', unit: 'crate' },
      ],
    }).expect(400);
    expect(res.body).toMatchObject({
      code: 'inventory.import_invalid',
      details: { rows: [{ row: 2, field: 'unit', problem: 'invalid' }] },
    });
    const after = stockItemListResponseSchema.parse(
      (await get(s.owner, '/inventory/items').expect(200)).body,
    );
    expect(after.data.map((i) => i.name)).not.toContain('Sugar');
  });

  it('saves brand and pack size from item rows, by shown unit names, and keeps them on empty cells', async () => {
    const s = await setup();
    await post(s.owner, '/inventory/items/import', {
      rows: [
        { name: 'Coconut milk', unit: 'pc', brand: 'Chaokoh', packSize: '12 x 500 ml' },
        { name: 'Eggs', unit: 'pc', packSize: 'Pack of 6' },
        // The default German name of pieces.
        { name: 'Cups', unit: 'pc', packSize: '10 Stk.' },
      ],
    }).expect(200);
    const list = async () =>
      stockItemListResponseSchema.parse((await get(s.owner, '/inventory/items').expect(200)).body)
        .data;
    const pick = (data: Awaited<ReturnType<typeof list>>, name: string) =>
      data.find((i) => i.name === name)!;
    let items = await list();
    expect(pick(items, 'Coconut milk')).toMatchObject({
      brand: 'Chaokoh',
      packCount: 12,
      packSize: '500.000',
      packUnit: 'ml',
    });
    expect(pick(items, 'Eggs')).toMatchObject({ packCount: 6, packSize: null, packUnit: null });
    // A whole number of pieces is a count, not a size.
    expect(pick(items, 'Cups')).toMatchObject({ packCount: 10, packSize: null, packUnit: null });
    // Empty cells keep what the item has; a filled one replaces it.
    const again = dataImportResultSchema.parse(
      (
        await post(s.owner, '/inventory/items/import', {
          rows: [
            { name: 'Coconut milk', unit: 'pc', brand: '', packSize: '' },
            { name: 'Eggs', unit: 'pc', packSize: '12' },
          ],
        }).expect(200)
      ).body,
    );
    expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    items = await list();
    expect(pick(items, 'Coconut milk')).toMatchObject({ brand: 'Chaokoh', packCount: 12 });
    expect(pick(items, 'Eggs').packCount).toBe(12);
    // A bad pack size refuses the whole file.
    const res = await post(s.owner, '/inventory/items/import', {
      rows: [
        { name: 'Sugar', unit: 'kg', packSize: '1 x' },
        { name: 'Salt', unit: 'kg', packSize: '5 crate' },
      ],
    }).expect(400);
    expect(res.body).toMatchObject({
      code: 'inventory.import_invalid',
      details: {
        rows: [
          { row: 1, field: 'packSize', problem: 'invalid' },
          { row: 2, field: 'packSize', problem: 'invalid' },
        ],
      },
    });
  });

  it('files imported items under existing categories by name or path, and refuses unknown ones', async () => {
    const s = await setup();
    const category = async (token: string, name: string, parentId?: string) =>
      (
        (
          await post(token, '/catalog/categories', {
            name,
            ...(parentId ? { parentId } : {}),
          }).expect(201)
        ).body as { id: string }
      ).id;
    const food = await category(s.owner, 'Food');
    const oil = await category(s.owner, 'Oil', food);
    const drinks = await category(s.owner, 'Drinks');
    const tea = await category(s.owner, 'Tea', drinks);
    // Names are unique per organization, but only exactly: "oil" and "Oil" read the same to the import.
    await category(s.owner, 'oil');
    const rice = await category(s.owner, 'Rice');
    const ghee = await category(s.owner, 'Oil / Ghee');
    const list = async () =>
      stockItemListResponseSchema.parse((await get(s.owner, '/inventory/items').expect(200)).body)
        .data;
    const categoryOf = async (name: string) =>
      (await list()).find((i) => i.name === name)?.categoryId;

    // Create: by name (any case), by path, and a name that contains a slash.
    await post(s.owner, '/inventory/items/import', {
      rows: [
        { name: 'Basmati', unit: 'kg', category: 'rice' },
        { name: 'Sunflower oil', unit: 'l', category: 'Food / Oil' },
        { name: 'Clarified butter', unit: 'kg', category: 'Oil / Ghee' },
        { name: 'Salt', unit: 'kg' },
      ],
    }).expect(200);
    expect(await categoryOf('Basmati')).toBe(rice);
    expect(await categoryOf('Sunflower oil')).toBe(oil);
    expect(await categoryOf('Clarified butter')).toBe(ghee);
    expect(await categoryOf('Salt')).toBeNull();

    // Update: an empty cell keeps the category, a filled one replaces it.
    await post(s.owner, '/inventory/items/import', {
      rows: [
        { name: 'Basmati', unit: 'kg', category: '', salePrice: '3.00' },
        { name: 'Sunflower oil', unit: 'l', category: 'Drinks / Tea' },
      ],
    }).expect(200);
    expect(await categoryOf('Basmati')).toBe(rice);
    expect(await categoryOf('Sunflower oil')).toBe(tea);

    // Unknown and ambiguous names refuse the whole file; nothing is created.
    const res = await post(s.owner, '/inventory/items/import', {
      rows: [
        { name: 'Fresh', unit: 'kg', category: 'Rice' },
        { name: 'Olive oil', unit: 'l', category: 'Dairy' },
        { name: 'Peanut oil', unit: 'l', category: 'OIL' },
      ],
    }).expect(400);
    expect(res.body).toMatchObject({
      code: 'inventory.import_invalid',
      details: {
        rows: [
          { row: 2, field: 'category', problem: 'unknown' },
          { row: 3, field: 'category', problem: 'ambiguous' },
        ],
      },
    });
    expect((await list()).map((i) => i.name)).not.toContain('Fresh');

    // Another tenant's category is unknown here, and nothing is created from the import.
    const other = await setup();
    await category(other.owner, 'Spices');
    const foreign = await post(s.owner, '/inventory/items/import', {
      rows: [{ name: 'Pepper', unit: 'kg', category: 'Spices' }],
    }).expect(400);
    expect(foreign.body).toMatchObject({
      details: { rows: [{ row: 1, field: 'category', problem: 'unknown' }] },
    });
    const mine = productCategoryListResponseSchema.parse(
      (await get(s.owner, '/catalog/categories').expect(200)).body,
    );
    expect(mine.data.map((c) => c.name)).not.toContain('Spices');
  });

  it('books opening stock as one receipt per warehouse, refusing unknown names', async () => {
    const s = await setup();
    const warehouse = async (name: string) =>
      warehouseSchema.parse(
        (
          await post(s.owner, '/inventory/warehouses', {
            locationId: s.org.locations[0],
            name,
          }).expect(201)
        ).body,
      ).id;
    const main = await warehouse('Main');
    const cold = await warehouse('Cold room');
    await post(s.owner, '/inventory/items', { name: 'Rice', unit: 'pc', sku: 'R-1' }).expect(201);
    await post(s.owner, '/inventory/items', { name: 'Fish', unit: 'kg' }).expect(201);
    await post(s.owner, '/inventory/opening-stock/import', {
      rows: [{ warehouse: 'Nowhere', item: 'R-1', quantity: '1', unitCost: '1' }],
    }).expect(400);
    const result = dataImportResultSchema.parse(
      (
        await post(s.owner, '/inventory/opening-stock/import', {
          rows: [
            { warehouse: 'main', item: 'R-1', quantity: '10', unitCost: '8.50' },
            { warehouse: 'Cold room', item: 'fish', quantity: '2.5', unitCost: '20' },
          ],
        }).expect(200)
      ).body,
    );
    expect(result.documents).toHaveLength(2);
    const level = async (warehouseId: string) =>
      stockLevelListResponseSchema
        .parse((await get(s.owner, `/inventory/stock?warehouseId=${warehouseId}`).expect(200)).body)
        .data.map((l) => [l.itemName, l.quantity, l.averageCost]);
    expect(await level(main)).toEqual([['Rice', '10.000', '8.5000']]);
    expect(await level(cold)).toEqual([['Fish', '2.500', '20.0000']]);
  });

  it('imports customers by code or name; staff may not import', async () => {
    const s = await setup();
    await post(s.owner, '/orders/customers', { name: 'Lotus', code: 'C-1' }).expect(201);
    const result = dataImportResultSchema.parse(
      (
        await post(s.owner, '/orders/customers/import', {
          rows: [
            { name: 'Lotus Mart', code: 'C-1', phone: '+60 12' },
            { name: 'Sunrise Grocers', email: 'buy@sunrise.example' },
          ],
        }).expect(200)
      ).body,
    );
    expect(result).toMatchObject({ created: 1, updated: 1 });
    const list = orderCustomerListResponseSchema.parse(
      (await get(s.owner, '/orders/customers').expect(200)).body,
    );
    expect(list.data.map((c) => c.name)).toEqual(['Lotus Mart', 'Sunrise Grocers']);
    const staff = await memberToken(s.org, 'staff');
    await post(staff, '/orders/customers/import', { rows: [{ name: 'X' }] }).expect(403);
  });

  it('replays an import with the same key instead of importing twice', async () => {
    const s = await setup();
    const key = uuidv7();
    const body = { rows: [{ name: 'Once' }] };
    await post(s.owner, '/orders/customers/import', body, key).expect(200);
    await post(s.owner, '/orders/customers/import', body, key).expect(200);
    const list = orderCustomerListResponseSchema.parse(
      (await get(s.owner, '/orders/customers').expect(200)).body,
    );
    expect(list.data.filter((c) => c.name === 'Once')).toHaveLength(1);
  });
});
