import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  categoryBulkResponseSchema,
  type PlanKey,
  productBulkResponseSchema,
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

/** docs/modules/catalog.md → Bulk actions. */
describe('POST /api/v1/catalog/{products,categories}/bulk', () => {
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

  const post = (token: string, path: string, body: object, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1/catalog/${path}/bulk`).auth(token, { type: 'bearer' }),
      key,
    ).send(body);

  const createCategory = async (token: string, name: string) =>
    (
      await withIdempotencyKey(
        request(server).post('/api/v1/catalog/categories').auth(token, { type: 'bearer' }),
      )
        .send({ name })
        .expect(201)
    ).body as { id: string };

  const createProduct = async (token: string, categoryId: string, name: string, price = '10.00') =>
    (
      await withIdempotencyKey(
        request(server).post('/api/v1/catalog/products').auth(token, { type: 'bearer' }),
      )
        .send({ categoryId, name, price, taxRate: '7' })
        .expect(201)
    ).body as { id: string };

  const products = async (token: string) =>
    productListResponseSchema.parse(
      (
        await request(server)
          .get('/api/v1/catalog/products')
          .query({ archived: 'true' })
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body,
    ).data;

  /** An order line of the product: the database then refuses to delete it (ON DELETE RESTRICT). */
  async function sell(org: SeededOrg, productId: string) {
    const locationId = org.locations[0];
    await seed.as(org.id, async (db) => {
      const table = await db.diningTable.create({
        data: { tenantId: org.id, locationId, name: `T-${uuidv7()}`, seats: 2 },
      });
      const userId = uuidv7();
      const order = await db.posOrder.create({
        data: {
          tenantId: org.id,
          locationId,
          tableId: table.id,
          number: `O-${uuidv7().slice(-12)}`,
          openedByUserId: userId,
        },
      });
      const ticket = await db.posKitchenTicket.create({
        data: {
          tenantId: org.id,
          orderId: order.id,
          sequence: 1,
          kind: 'order',
          createdByUserId: userId,
        },
      });
      await db.posOrderLine.create({
        data: {
          tenantId: org.id,
          orderId: order.id,
          ticketId: ticket.id,
          productId,
          productName: 'Sold',
          unitPrice: '10.00',
          taxRate: '7',
          quantity: 1,
          createdByUserId: userId,
        },
      });
    });
  }

  it('archives, restores and edits products; unchanged ones write no audit row', async () => {
    const { org, token } = await orgWith('owner');
    const cat = await createCategory(token, 'Drinks');
    const other = await createCategory(token, 'Wine');
    const a = await createProduct(token, cat.id, 'Cola', '3.00');
    const b = await createProduct(token, cat.id, 'Beer', '4.50');
    const ids = [a.id, b.id];

    const archived = productBulkResponseSchema.parse(
      (await post(token, 'products', { ids, action: { kind: 'archive' } }).expect(200)).body,
    );
    expect(archived.updated.sort()).toEqual([...ids].sort());
    const again = productBulkResponseSchema.parse(
      (await post(token, 'products', { ids, action: { kind: 'archive' } }).expect(200)).body,
    );
    expect(again.updated).toEqual([]);
    await post(token, 'products', { ids, action: { kind: 'restore' } }).expect(200);

    await post(token, 'products', {
      ids,
      action: { kind: 'price', change: { mode: 'percent', value: '10' } },
    }).expect(200);
    await post(token, 'products', { ids, action: { kind: 'vat', taxRate: '19' } }).expect(200);
    await post(token, 'products', { ids, action: { kind: 'move', categoryId: other.id } }).expect(
      200,
    );

    const rows = await products(token);
    expect(
      rows.map((p) => [p.name, p.price, p.taxRate, p.categoryId, p.archivedAt === null]).sort(),
    ).toEqual([
      ['Beer', '4.95', '19.00', other.id, true],
      ['Cola', '3.30', '19.00', other.id, true],
    ]);
    const audit = await seed.as(org.id, (db) =>
      db.auditLog.count({ where: { action: 'catalog.product.updated' } }),
    );
    // archive ×2, restore ×2, price ×2, vat ×2, move ×2; the repeated archive wrote nothing.
    expect(audit).toBe(10);
  });

  it('changes nothing when an id is unknown or a price would go negative', async () => {
    const { token } = await orgWith('owner');
    const cat = await createCategory(token, 'Drinks');
    const a = await createProduct(token, cat.id, 'Cola', '3.00');
    const b = await createProduct(token, cat.id, 'Beer', '1.00');

    const ghost = uuidv7();
    const missing = await post(token, 'products', {
      ids: [a.id, ghost],
      action: { kind: 'archive' },
    }).expect(404);
    expect(missing.body).toMatchObject({
      code: 'catalog.product_not_found',
      details: { ids: [ghost] },
    });

    const invalid = await post(token, 'products', {
      ids: [a.id, b.id],
      action: { kind: 'price', change: { mode: 'add', value: '-2' } },
    }).expect(400);
    expect(invalid.body).toMatchObject({ code: 'catalog.price_invalid', details: { ids: [b.id] } });

    expect(
      (await products(token)).map((p) => [p.name, p.price, p.archivedAt === null]).sort(),
    ).toEqual([
      ['Beer', '1.00', true],
      ['Cola', '3.00', true],
    ]);
  });

  it('refuses to move into an archived category', async () => {
    const { token } = await orgWith('owner');
    const cat = await createCategory(token, 'Drinks');
    const old = await createCategory(token, 'Old');
    const a = await createProduct(token, cat.id, 'Cola');
    await post(token, 'categories', { ids: [old.id], action: 'archive' }).expect(200);
    const res = await post(token, 'products', {
      ids: [a.id],
      action: { kind: 'move', categoryId: old.id },
    }).expect(409);
    expect(res.body).toMatchObject({ code: 'catalog.category_archived' });
  });

  it('deletes products never sold and keeps the sold ones', async () => {
    const { org, token } = await orgWith('owner');
    const cat = await createCategory(token, 'Drinks');
    const fresh = await createProduct(token, cat.id, 'Cola');
    const sold = await createProduct(token, cat.id, 'Beer');
    await sell(org, sold.id);

    const res = productBulkResponseSchema.parse(
      (
        await post(token, 'products', {
          ids: [fresh.id, sold.id],
          action: { kind: 'delete' },
        }).expect(200)
      ).body,
    );
    expect(res).toEqual({
      updated: [],
      deleted: [fresh.id],
      kept: [{ id: sold.id, reason: 'sold' }],
    });
    expect((await products(token)).map((p) => p.id)).toEqual([sold.id]);

    // The sold one can be archived instead (the "bulk update for archive" follow-up).
    await post(token, 'products', { ids: [sold.id], action: { kind: 'archive' } }).expect(200);
    expect((await products(token))[0]?.archivedAt).not.toBeNull();

    const audit = await seed.as(org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'catalog.product.deleted' } }),
    );
    expect(audit.map((a) => a.entityId)).toEqual([fresh.id]);
  });

  it('archives and restores categories', async () => {
    const { token } = await orgWith('owner');
    const a = await createCategory(token, 'A');
    const b = await createCategory(token, 'B');
    const ids = [a.id, b.id];
    const archived = categoryBulkResponseSchema.parse(
      (await post(token, 'categories', { ids, action: 'archive' }).expect(200)).body,
    );
    expect(archived.updated.sort()).toEqual([...ids].sort());
    expect(archived.productsDeleted).toBe(0);
    const again = categoryBulkResponseSchema.parse(
      (await post(token, 'categories', { ids, action: 'archive' }).expect(200)).body,
    );
    expect(again.updated).toEqual([]);
    const restored = categoryBulkResponseSchema.parse(
      (await post(token, 'categories', { ids, action: 'restore' }).expect(200)).body,
    );
    expect(restored.updated.sort()).toEqual([...ids].sort());

    const ghost = uuidv7();
    const res = await post(token, 'categories', { ids: [a.id, ghost], action: 'archive' }).expect(
      404,
    );
    expect(res.body).toMatchObject({
      code: 'catalog.category_not_found',
      details: { ids: [ghost] },
    });
  });

  it('deletes a category with its products, but keeps one with a sold product whole', async () => {
    const { org, token } = await orgWith('owner');
    const empty = await createCategory(token, 'Empty');
    const plain = await createCategory(token, 'Plain');
    const mixed = await createCategory(token, 'Mixed');
    await createProduct(token, plain.id, 'Cola');
    await createProduct(token, plain.id, 'Fanta');
    await createProduct(token, mixed.id, 'Water');
    const sold = await createProduct(token, mixed.id, 'Beer');
    await sell(org, sold.id);

    const res = categoryBulkResponseSchema.parse(
      (
        await post(token, 'categories', {
          ids: [empty.id, plain.id, mixed.id],
          action: 'delete',
        }).expect(200)
      ).body,
    );
    expect(res.deleted.sort()).toEqual([empty.id, plain.id].sort());
    expect(res.kept).toEqual([{ id: mixed.id, reason: 'sold' }]);
    expect(res.productsDeleted).toBe(2);

    // Nothing of the kept category is gone: Water survived the rolled-back savepoint.
    expect((await products(token)).map((p) => p.name).sort()).toEqual(['Beer', 'Water']);
    const cats = await seed.as(org.id, (db) => db.productCategory.findMany());
    expect(cats.map((c) => c.id)).toEqual([mixed.id]);
  });

  it('replays a repeated request instead of running it twice', async () => {
    const { org, token } = await orgWith('owner');
    const cat = await createCategory(token, 'Drinks');
    const a = await createProduct(token, cat.id, 'Cola');
    const key = uuidv7();
    const body = { ids: [a.id], action: { kind: 'delete' } };
    const first = await post(token, 'products', body, key).expect(200);
    const again = await post(token, 'products', body, key).expect(200);
    expect(again.body).toEqual(first.body);
    expect(
      await seed.as(org.id, (db) =>
        db.auditLog.count({ where: { action: 'catalog.product.deleted' } }),
      ),
    ).toBe(1);
  });

  it('validates the body', async () => {
    const { token } = await orgWith('owner');
    await post(token, 'products', { ids: [], action: { kind: 'archive' } }).expect(400);
    await post(token, 'products', { ids: [uuidv7()], action: { kind: 'explode' } }).expect(400);
    await post(token, 'categories', { ids: [uuidv7()], action: 'move' }).expect(400);
  });

  it('needs catalog.products.manage and the catalog feature', async () => {
    for (const role of ['staff', 'waiter', 'cashier', 'manager'] as const) {
      const { token } = await orgWith(role);
      for (const [path, body] of [
        ['products', { ids: [uuidv7()], action: { kind: 'delete' } }],
        ['categories', { ids: [uuidv7()], action: 'delete' }],
      ] as const) {
        const res = await post(token, path, body).expect(403);
        expect(res.body).toMatchObject({ details: { permission: 'catalog.products.manage' } });
      }
    }
    const { org } = await orgWith('owner');
    await entitlements.setOverride(org.id, 'catalog', false, undefined, 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const res = await post(owner, 'products', {
      ids: [uuidv7()],
      action: { kind: 'archive' },
    }).expect(403);
    expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
  });

  it("never touches another organization's rows", async () => {
    const { token: a } = await orgWith('owner');
    const { org: orgB, token: b } = await orgWith('owner');
    const catA = await createCategory(a, 'Drinks');
    const prodA = await createProduct(a, catA.id, 'Cola');
    const catB = await createCategory(b, 'Drinks');
    await createProduct(b, catB.id, 'Cola');

    const p = await post(b, 'products', { ids: [prodA.id], action: { kind: 'delete' } }).expect(
      200,
    );
    expect(p.body).toEqual({ updated: [], deleted: [], kept: [] });
    await post(b, 'products', { ids: [prodA.id], action: { kind: 'archive' } }).expect(404);
    await post(b, 'categories', { ids: [catA.id], action: 'archive' }).expect(404);
    const c = await post(b, 'categories', { ids: [catA.id], action: 'delete' }).expect(200);
    expect(c.body).toMatchObject({ deleted: [], kept: [], productsDeleted: 0 });

    expect((await products(a)).map((x) => x.id)).toEqual([prodA.id]);
    expect(await seed.as(orgB.id, (db) => db.product.count())).toBe(1);
  });
});
