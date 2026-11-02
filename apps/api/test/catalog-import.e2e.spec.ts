import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  importProductsResponseSchema,
  type PlanKey,
  productListResponseSchema,
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

/** docs/modules/catalog.md → Import. */
describe('POST /api/v1/catalog/products/import', () => {
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

  const upload = (token: string, rows: object[], key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post('/api/v1/catalog/products/import').auth(token, { type: 'bearer' }),
      key,
    ).send({ rows });

  const products = async (token: string) =>
    productListResponseSchema.parse(
      (
        await request(server)
          .get('/api/v1/catalog/products')
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body,
    ).data;

  const MENU = [
    {
      category: 'Starters',
      name: 'Kimchi',
      price: '4.50',
      taxRate: '7',
      description: 'House-made',
    },
    { category: 'BBQ', name: 'So-Galbi', price: '24.9', taxRate: '7' },
    { category: 'Drinks', name: 'Soju', price: '7', taxRate: '19' },
  ];

  it('creates categories and products, then updates only what changed', async () => {
    const { org, token } = await orgWith('owner');
    const first = importProductsResponseSchema.parse((await upload(token, MENU).expect(200)).body);
    expect(first).toMatchObject({ created: 3, updated: 0, unchanged: 0, categoriesCreated: 3 });
    expect(
      (await products(token)).map((p) => [p.name, p.price, p.taxRate, p.description]).sort(),
    ).toEqual([
      ['Kimchi', '4.50', '7.00', 'House-made'],
      ['So-Galbi', '24.90', '7.00', null],
      ['Soju', '7.00', '19.00', null],
    ]);

    // Same file with a new price, another case and no description column: one update.
    const second = importProductsResponseSchema.parse(
      (
        await upload(token, [
          { category: 'starters', name: 'KIMCHI', price: '4.50', taxRate: '7.00' },
          { category: 'BBQ', name: 'So-Galbi', price: '26.00', taxRate: '7' },
          { category: 'Drinks', name: 'Soju', price: '7.00', taxRate: '19' },
          { category: 'Drinks', name: 'Beer', price: '5.50', taxRate: '19' },
        ]).expect(200)
      ).body,
    );
    expect(second).toMatchObject({ created: 1, updated: 1, unchanged: 2, categoriesCreated: 0 });
    expect(second.rows.map((r) => r.status)).toEqual([
      'unchanged',
      'updated',
      'unchanged',
      'created',
    ]);
    const kimchi = (await products(token)).find((p) => p.name === 'Kimchi');
    expect(kimchi).toMatchObject({ price: '4.50', description: 'House-made' });

    const audit = await seed.as(org.id, (db) =>
      db.auditLog.groupBy({ by: ['action'], _count: true, orderBy: { action: 'asc' } }),
    );
    expect(Object.fromEntries(audit.map((a) => [a.action, a._count]))).toMatchObject({
      'catalog.product_category.created': 3,
      'catalog.product.created': 4,
      'catalog.product.updated': 1,
    });
  });

  it('writes nothing when any row is invalid, and names every problem', async () => {
    const { token } = await orgWith('owner');
    const res = await upload(token, [
      ...MENU,
      { category: '', name: 'Ramen', price: '12', taxRate: '7' },
      { category: 'Drinks', name: 'soju', price: '4,50', taxRate: '7' },
    ]).expect(400);
    expect(res.body).toMatchObject({
      code: 'catalog.import_invalid',
      details: {
        rows: [
          { row: 4, field: 'category', problem: 'required' },
          { row: 5, field: 'price', problem: 'invalid' },
          { row: 5, field: 'name', problem: 'duplicate' },
        ],
      },
    });
    expect(await products(token)).toEqual([]);
  });

  it('leaves archived products alone and creates a new one of the same name', async () => {
    const { token } = await orgWith('owner');
    await upload(token, MENU).expect(200);
    const soju = (await products(token)).find((p) => p.name === 'Soju')!;
    await withIdempotencyKey(
      request(server).patch(`/api/v1/catalog/products/${soju.id}`).auth(token, { type: 'bearer' }),
    )
      .send({ archived: true })
      .expect(200);
    const res = importProductsResponseSchema.parse(
      (
        await upload(token, [
          { category: 'Drinks', name: 'Soju', price: '8', taxRate: '19' },
        ]).expect(200)
      ).body,
    );
    expect(res).toMatchObject({ created: 1, updated: 0 });
    expect(res.rows[0]?.productId).not.toBe(soju.id);
  });

  it('replays a repeated request instead of importing twice', async () => {
    const { org, token } = await orgWith('owner');
    const key = uuidv7();
    const first = await upload(token, MENU, key).expect(200);
    const again = await upload(token, MENU, key).expect(200);
    expect(again.body).toEqual(first.body);
    expect(await seed.as(org.id, (db) => db.product.count())).toBe(3);
  });

  it('needs catalog.products.manage and the catalog feature', async () => {
    for (const role of ['staff', 'waiter', 'cashier', 'manager'] as const) {
      const { token } = await orgWith(role);
      const res = await upload(token, MENU).expect(403);
      expect(res.body).toMatchObject({ details: { permission: 'catalog.products.manage' } });
    }
    const { org } = await orgWith('owner');
    await entitlements.setOverride(org.id, 'catalog', false, undefined, 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const res = await upload(owner, MENU).expect(403);
    expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
  });

  it("never reuses another organization's categories or products", async () => {
    const { token: a } = await orgWith('owner');
    const { org: orgB, token: b } = await orgWith('owner');
    await upload(a, MENU).expect(200);
    const res = importProductsResponseSchema.parse((await upload(b, MENU).expect(200)).body);
    expect(res).toMatchObject({ created: 3, categoriesCreated: 3, updated: 0, unchanged: 0 });
    expect(await seed.as(orgB.id, (db) => db.productCategory.count())).toBe(3);
    expect((await products(a)).map((p) => p.id).sort()).not.toEqual(
      (await products(b)).map((p) => p.id).sort(),
    );
  });
});
