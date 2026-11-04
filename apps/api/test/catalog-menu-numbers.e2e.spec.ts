import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  numberProductsResponseSchema,
  type PlanKey,
  type Product,
  productCategoryListResponseSchema,
  productListResponseSchema,
  productSchema,
  type SystemRole,
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

/** docs/modules/catalog.md → Menu numbers (ADR 0029). */
describe('catalog menu numbers', () => {
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

  async function orgWith(role: SystemRole, plan: PlanKey = 'full') {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    return { org, token: await memberToken(org, role) };
  }

  async function memberToken(org: SeededOrg, role: SystemRole) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return seed.token(userId, org.id);
  }

  const send = (token: string, method: 'post' | 'patch', path: string, body?: object) =>
    withIdempotencyKey(
      request(server)[method](`/api/v1/catalog/${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);

  async function category(token: string, name: string, sortOrder = 0): Promise<string> {
    const res = await send(token, 'post', 'categories', { name, sortOrder }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function product(
    token: string,
    categoryId: string,
    name: string,
    extra: object = {},
  ): Promise<Product> {
    const res = await send(token, 'post', 'products', {
      categoryId,
      name,
      price: '5.00',
      taxRate: '7',
      ...extra,
    }).expect(201);
    return productSchema.parse(res.body);
  }

  const list = async (token: string) =>
    productListResponseSchema.parse(
      (await request(server).get('/api/v1/catalog/products').auth(token, { type: 'bearer' })).body,
    ).data;
  const numbers = async (token: string) =>
    Object.fromEntries((await list(token)).map((p) => [p.name, p.menuNumber]));

  it('sets, changes and clears a number; trims it', async () => {
    const { token } = await orgWith('owner');
    const mains = await category(token, 'Mains');
    const curry = await product(token, mains, 'Curry', { menuNumber: ' 12a ' });
    expect(curry.menuNumber).toBe('12a');
    const changed = await send(token, 'patch', `products/${curry.id}`, {
      menuNumber: 'M-4',
    }).expect(200);
    expect(productSchema.parse(changed.body).menuNumber).toBe('M-4');
    const cleared = await send(token, 'patch', `products/${curry.id}`, {
      menuNumber: null,
    }).expect(200);
    expect(productSchema.parse(cleared.body).menuNumber).toBeNull();
    await send(token, 'patch', `products/${curry.id}`, { menuNumber: '1234567' }).expect(400);
  });

  it('refuses a number another product has, ignoring case; archiving frees it', async () => {
    const { token } = await orgWith('owner');
    const mains = await category(token, 'Mains');
    const curry = await product(token, mains, 'Curry', { menuNumber: '12a' });
    const dal = await product(token, mains, 'Dal');
    const taken = await send(token, 'patch', `products/${dal.id}`, { menuNumber: '12A' }).expect(
      409,
    );
    expect(taken.body).toMatchObject({ code: 'catalog.menu_number_taken' });
    await send(token, 'post', 'products', {
      categoryId: mains,
      name: 'Naan',
      price: '2.00',
      taxRate: '7',
      menuNumber: '12a',
    }).expect(409);

    await send(token, 'patch', `products/${curry.id}`, { archived: true }).expect(200);
    await send(token, 'patch', `products/${dal.id}`, { menuNumber: '12a' }).expect(200);
    // Restoring Curry would take 12a back: refused while Dal has it.
    const restore = await send(token, 'patch', `products/${curry.id}`, {
      archived: false,
    }).expect(409);
    expect(restore.body).toMatchObject({ code: 'catalog.menu_number_taken' });
  });

  it('imports numbers, keeps them on an empty cell, and refuses duplicates', async () => {
    const { token } = await orgWith('owner');
    const row = (name: string, number?: string) => ({
      category: 'Mains',
      name,
      price: '9.00',
      taxRate: '7',
      ...(number !== undefined && { number }),
    });
    await send(token, 'post', 'products/import', {
      rows: [row('Curry', '1'), row('Dal', '2')],
    }).expect(200);
    expect(await numbers(token)).toEqual({ Curry: '1', Dal: '2' });
    // No number column or an empty cell: unchanged.
    const again = await send(token, 'post', 'products/import', {
      rows: [row('Curry'), row('Dal', '')],
    }).expect(200);
    expect(again.body).toMatchObject({ unchanged: 2 });
    expect(await numbers(token)).toEqual({ Curry: '1', Dal: '2' });

    const inFile = await send(token, 'post', 'products/import', {
      rows: [row('Naan', '7'), row('Rice', '7')],
    }).expect(400);
    expect(inFile.body).toMatchObject({
      code: 'catalog.import_invalid',
      details: { rows: [{ row: 2, field: 'number', problem: 'duplicate' }] },
    });
    // Another product already has it: nothing is written.
    await send(token, 'post', 'products/import', { rows: [row('Naan', '1')] }).expect(409);
    expect(await numbers(token)).toEqual({ Curry: '1', Dal: '2' });
  });

  it('creates a category on the station a row asks for, never changing an existing one', async () => {
    const { token } = await orgWith('owner');
    await category(token, 'Drinks');
    const row = (category: string, name: string) => ({
      category,
      name,
      price: '3.00',
      taxRate: '19',
      station: 'bar',
    });
    await send(token, 'post', 'products/import', {
      rows: [row('Drinks', 'Soju'), row('Cocktails', 'Mojito')],
    }).expect(200);
    const categories = productCategoryListResponseSchema.parse(
      (await request(server).get('/api/v1/catalog/categories').auth(token, { type: 'bearer' }))
        .body,
    ).data;
    expect(Object.fromEntries(categories.map((c) => [c.name, c.station]))).toEqual({
      Drinks: 'kitchen',
      Cocktails: 'bar',
    });
  });

  it('fills missing numbers after the highest, in menu order, and audits each', async () => {
    const { org, token } = await orgWith('owner');
    const starters = await category(token, 'Starters', 0);
    const mains = await category(token, 'Mains', 1);
    await product(token, mains, 'Curry', { sortOrder: 1 });
    await product(token, mains, 'Biryani', { sortOrder: 0 });
    await product(token, starters, 'Samosa', { menuNumber: '3' });
    await product(token, starters, 'Pakora');
    await product(token, starters, 'Soup', { menuNumber: 'S1' });
    // "4" taken as text by an archived product doesn't block; a live "5" is skipped.
    const old = await product(token, mains, 'Old', { menuNumber: '4' });
    await send(token, 'patch', `products/${old.id}`, { archived: true }).expect(200);
    await product(token, mains, 'Lassi', { menuNumber: '5', sortOrder: 9 });

    const key = uuidv7();
    const run = () =>
      withIdempotencyKey(
        request(server).post('/api/v1/catalog/products/number').auth(token, { type: 'bearer' }),
        key,
      ).send();
    const first = await run().expect(200);
    expect(numberProductsResponseSchema.parse(first.body)).toEqual({ numbered: 3 });
    // Highest numeric is 5: Pakora (Starters) 6, then Mains by position: Biryani 7, Curry 8.
    expect(await numbers(token)).toEqual({
      Samosa: '3',
      Pakora: '6',
      Soup: 'S1',
      Biryani: '7',
      Curry: '8',
      Lassi: '5',
    });
    // A replay returns the stored answer; a new run finds nothing to do.
    expect((await run().expect(200)).body).toEqual({ numbered: 3 });
    const second = await send(token, 'post', 'products/number').expect(200);
    expect(second.body).toEqual({ numbered: 0 });

    const audited = await seed.as(org.id, (db) =>
      db.auditLog.count({ where: { action: 'catalog.product.updated' } }),
    );
    // The archive above, plus one per numbered product.
    expect(audited).toBe(4);
  });

  it('needs catalog.products.manage to number', async () => {
    const { org } = await orgWith('owner');
    const waiter = await memberToken(org, 'waiter');
    await send(waiter, 'post', 'products/number').expect(403);
  });

  it('lets two organizations use the same number', async () => {
    const a = await orgWith('owner');
    const b = await orgWith('owner');
    await product(a.token, await category(a.token, 'Mains'), 'Curry', { menuNumber: '1' });
    await product(b.token, await category(b.token, 'Mains'), 'Pizza', { menuNumber: '1' });
    expect(await numbers(a.token)).toEqual({ Curry: '1' });
    expect(await numbers(b.token)).toEqual({ Pizza: '1' });
    // Numbering in one organization never reads or changes the other's products.
    await product(b.token, (await list(b.token))[0]!.categoryId, 'Pasta');
    await send(a.token, 'post', 'products/number').expect(200);
    expect(await numbers(b.token)).toEqual({ Pizza: '1', Pasta: null });
  });
});
