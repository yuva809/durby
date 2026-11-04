import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type PlanKey,
  productCategoryListResponseSchema,
  productCategorySchema,
  productListResponseSchema,
  productSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { emptyPlanFor } from './support/plans';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/catalog.md → API: categories, products, archive, access, audit, isolation. */
describe('/api/v1/catalog', () => {
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

  type Role = 'owner' | 'admin' | 'manager' | 'staff';

  async function orgWith(
    role: Role,
    plan: PlanKey = 'full',
  ): Promise<{ org: SeededOrg; token: string }> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    return { org, token: await memberToken(org, role) };
  }

  async function memberToken(org: SeededOrg, role: Role, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1/catalog${path}`).auth(token, { type: 'bearer' });

  const send = (
    token: string,
    method: 'post' | 'patch',
    path: string,
    body: unknown,
    key = uuidv7(),
  ) =>
    withIdempotencyKey(
      request(server)[method](`/api/v1/catalog${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body as object);

  async function category(token: string, name = `C-${uuidv7()}`) {
    const res = await send(token, 'post', '/categories', { name }).expect(201);
    return productCategorySchema.parse(res.body);
  }

  async function product(token: string, categoryId: string, extra: object = {}) {
    const res = await send(token, 'post', '/products', {
      categoryId,
      name: `P-${uuidv7()}`,
      price: '12.5',
      taxRate: '7',
      ...extra,
    }).expect(201);
    return productSchema.parse(res.body);
  }

  const auditRows = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: { entityType: { in: ['product_category', 'product'] } },
        orderBy: { id: 'asc' },
        select: { action: true, entityId: true, before: true, after: true },
      }),
    );

  describe('categories', () => {
    it('creates, lists in sort order, renames and archives', async () => {
      const { token } = await orgWith('owner');
      const drinks = await category(token, 'Drinks');
      const food = (
        await send(token, 'post', '/categories', { name: '  Food ', sortOrder: 0 }).expect(201)
      ).body as { id: string; name: string };
      expect(food.name).toBe('Food');
      await send(token, 'patch', `/categories/${drinks.id}`, { sortOrder: 5 }).expect(200);

      const listed = productCategoryListResponseSchema.parse(
        (await get(token, '/categories').expect(200)).body,
      );
      expect(listed.data.map((c) => c.name)).toEqual(['Food', 'Drinks']);

      const archived = productCategorySchema.parse(
        (await send(token, 'patch', `/categories/${drinks.id}`, { archived: true }).expect(200))
          .body,
      );
      expect(archived.archivedAt).not.toBeNull();
      const active = productCategoryListResponseSchema.parse(
        (await get(token, '/categories').expect(200)).body,
      );
      expect(active.data.map((c) => c.name)).toEqual(['Food']);
      const all = productCategoryListResponseSchema.parse(
        (await get(token, '/categories?includeArchived=true').expect(200)).body,
      );
      expect(all.data.map((c) => c.name)).toEqual(['Food', 'Drinks']);
    });

    it('sets the station: kitchen by default, bar for drinks (ADR 0025)', async () => {
      const { token } = await orgWith('owner');
      const food = await category(token, 'Food');
      expect(food.station).toBe('kitchen');
      const drinks = productCategorySchema.parse(
        (await send(token, 'post', '/categories', { name: 'Drinks', station: 'bar' }).expect(201))
          .body,
      );
      expect(drinks.station).toBe('bar');
      const moved = productCategorySchema.parse(
        (await send(token, 'patch', `/categories/${food.id}`, { station: 'bar' }).expect(200)).body,
      );
      expect(moved).toMatchObject({ name: 'Food', station: 'bar' });
      await send(token, 'post', '/categories', { name: 'X', station: 'grill' }).expect(400);
    });

    it('keeps names unique among non-archived categories', async () => {
      const { token } = await orgWith('owner');
      const first = await category(token, 'Desserts');
      const res = await send(token, 'post', '/categories', { name: 'Desserts' }).expect(409);
      expect(res.body).toMatchObject({ code: 'catalog.category_name_taken' });
      await send(token, 'patch', `/categories/${first.id}`, { archived: true }).expect(200);
      const second = await category(token, 'Desserts');
      // Restoring the archived one would clash with the new one.
      const clash = await send(token, 'patch', `/categories/${first.id}`, {
        archived: false,
      }).expect(409);
      expect(clash.body).toMatchObject({ code: 'catalog.category_name_taken' });
      expect(second.name).toBe('Desserts');
    });

    it('rejects invalid bodies', async () => {
      const { token } = await orgWith('owner');
      await send(token, 'post', '/categories', { name: '   ' }).expect(400);
      await send(token, 'post', '/categories', { name: 'X', extra: 1 }).expect(400);
      const c = await category(token);
      await send(token, 'patch', `/categories/${c.id}`, {}).expect(400);
    });

    it('answers 404 for unknown ids and bad UUIDs', async () => {
      const { token } = await orgWith('owner');
      const res = await send(token, 'patch', `/categories/${uuidv7()}`, { name: 'X' }).expect(404);
      expect(res.body).toMatchObject({ code: 'catalog.category_not_found' });
      await send(token, 'patch', '/categories/not-a-uuid', { name: 'X' }).expect(404);
    });
  });

  describe('products', () => {
    it('creates with decimal strings, filters by category, edits and archives', async () => {
      const { token } = await orgWith('owner');
      const food = await category(token, 'Food');
      const drinks = await category(token, 'Drinks');
      const soup = await product(token, food.id, {
        name: 'Soup',
        description: '  Tomato ',
        price: '6.9',
        taxRate: '7.00',
      });
      expect(soup).toMatchObject({
        name: 'Soup',
        description: 'Tomato',
        price: '6.90',
        taxRate: '7.00',
        categoryId: food.id,
        archivedAt: null,
      });
      const water = await product(token, drinks.id, { name: 'Water', price: '2', taxRate: '19' });
      expect(water.price).toBe('2.00');

      const inFood = productListResponseSchema.parse(
        (await get(token, `/products?categoryId=${food.id}`).expect(200)).body,
      );
      expect(inFood.data.map((p) => p.name)).toEqual(['Soup']);

      const edited = productSchema.parse(
        (
          await send(token, 'patch', `/products/${soup.id}`, {
            price: '7.40',
            description: '',
            categoryId: drinks.id,
          }).expect(200)
        ).body,
      );
      expect(edited).toMatchObject({ price: '7.40', description: null, categoryId: drinks.id });

      await send(token, 'patch', `/products/${soup.id}`, { archived: true }).expect(200);
      const active = productListResponseSchema.parse(
        (await get(token, '/products').expect(200)).body,
      );
      expect(active.data.map((p) => p.name)).toEqual(['Water']);
    });

    it('validates price and tax rate', async () => {
      const { token } = await orgWith('owner');
      const c = await category(token);
      for (const body of [
        { price: '-1', taxRate: '7' },
        { price: '1.234', taxRate: '7' },
        { price: 12.5, taxRate: '7' },
        { price: '1', taxRate: '100.01' },
        { price: '1', taxRate: '7%' },
      ]) {
        await send(token, 'post', '/products', { categoryId: c.id, name: 'X', ...body }).expect(
          400,
        );
      }
      await product(token, c.id, { price: '0', taxRate: '0' });
      await product(token, c.id, { price: '9999999999.99', taxRate: '100' });
    });

    it('needs an existing, non-archived category', async () => {
      const { token } = await orgWith('owner');
      const missing = await send(token, 'post', '/products', {
        categoryId: uuidv7(),
        name: 'X',
        price: '1',
        taxRate: '7',
      }).expect(404);
      expect(missing.body).toMatchObject({ code: 'catalog.category_not_found' });

      const c = await category(token);
      const p = await product(token, c.id);
      await send(token, 'patch', `/categories/${c.id}`, { archived: true }).expect(200);
      const res = await send(token, 'post', '/products', {
        categoryId: c.id,
        name: 'Y',
        price: '1',
        taxRate: '7',
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'catalog.category_archived' });
      // Editing a product of an archived category is fine as long as it doesn't move into one.
      await send(token, 'patch', `/products/${p.id}`, { price: '3' }).expect(200);
    });

    it('keeps names unique per category among non-archived products', async () => {
      const { token } = await orgWith('owner');
      const a = await category(token);
      const b = await category(token);
      await product(token, a.id, { name: 'Cola' });
      await product(token, b.id, { name: 'Cola' });
      const res = await send(token, 'post', '/products', {
        categoryId: a.id,
        name: 'Cola',
        price: '1',
        taxRate: '19',
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'catalog.product_name_taken' });
    });
  });

  describe('access', () => {
    it('lets every system role read and only owner and admin manage', async () => {
      const { org, token: owner } = await orgWith('owner');
      const c = await category(owner);
      for (const role of ['admin', 'manager', 'staff'] as const) {
        const token = await memberToken(org, role);
        await get(token, '/categories').expect(200);
        await get(token, '/products').expect(200);
        const status = role === 'admin' ? 201 : 403;
        await send(token, 'post', '/categories', { name: `By ${role}` }).expect(status);
        await send(token, 'patch', `/categories/${c.id}`, { sortOrder: 1 }).expect(
          role === 'admin' ? 200 : 403,
        );
      }
    });

    it('lets a location-limited member read the menu', async () => {
      const { org, token: owner } = await orgWith('owner');
      await category(owner, 'Food');
      const token = await memberToken(org, 'staff', [org.locations[0]]);
      const res = await get(token, '/categories').expect(200);
      expect(productCategoryListResponseSchema.parse(res.body).data.map((c) => c.name)).toEqual([
        'Food',
      ]);
    });

    it('needs the catalog feature', async () => {
      const { org, token } = await orgWith('owner');
      await emptyPlanFor(org.id);
      const res = await get(token, '/products').expect(403);
      expect(res.body).toMatchObject({ code: 'entitlements.feature_disabled' });
    });
  });

  describe('idempotency', () => {
    it('replays a repeated create instead of creating twice', async () => {
      const { org, token } = await orgWith('owner');
      const key = uuidv7();
      const first = await send(token, 'post', '/categories', { name: 'Once' }, key).expect(201);
      const again = await send(token, 'post', '/categories', { name: 'Once' }, key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await seed.as(org.id, (db) => db.productCategory.count())).toBe(1);
    });
  });

  describe('audit', () => {
    it('records creates and changes with allow-listed snapshots, and nothing for no-ops', async () => {
      const { org, token } = await orgWith('owner');
      const c = await category(token, 'Food');
      const p = await product(token, c.id, { name: 'Soup', description: 'secret-ish text' });
      await send(token, 'patch', `/products/${p.id}`, { price: '8' }).expect(200);
      await send(token, 'patch', `/products/${p.id}`, { price: '8.00' }).expect(200);

      const rows = await auditRows(org.id);
      expect(rows.map((r) => r.action)).toEqual([
        'catalog.product_category.created',
        'catalog.product.created',
        'catalog.product.updated',
      ]);
      expect(rows[1]?.after).toEqual({
        id: p.id,
        categoryId: c.id,
        name: 'Soup',
        menuNumber: null,
        price: '12.50',
        taxRate: '7.00',
        sortOrder: 0,
        archivedAt: null,
      });
      expect(rows[2]).toMatchObject({
        before: { price: '12.50' },
        after: { price: '8.00' },
      });
      expect(JSON.stringify(rows)).not.toContain('secret-ish');
    });
  });

  describe('tenant isolation', () => {
    it("never shows or changes another organization's categories and products", async () => {
      const { token: a } = await orgWith('owner');
      const { token: b } = await orgWith('owner');
      const c = await category(a, 'Only A');
      const p = await product(a, c.id);

      const listed = productCategoryListResponseSchema.parse(
        (await get(b, '/categories?includeArchived=true').expect(200)).body,
      );
      expect(listed.data).toEqual([]);
      expect(
        productListResponseSchema.parse((await get(b, '/products').expect(200)).body).data,
      ).toEqual([]);

      await send(b, 'patch', `/categories/${c.id}`, { name: 'Taken' }).expect(404);
      await send(b, 'patch', `/products/${p.id}`, { price: '0' }).expect(404);
      const res = await send(b, 'post', '/products', {
        categoryId: c.id,
        name: 'X',
        price: '1',
        taxRate: '7',
      }).expect(404);
      expect(res.body).toMatchObject({ code: 'catalog.category_not_found' });

      const after = productListResponseSchema.parse(
        (await get(a, `/products?categoryId=${c.id}`).expect(200)).body,
      );
      expect(after.data.map((x) => x.price)).toEqual(['12.50']);
    });
  });
});
