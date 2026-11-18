import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { productCategorySchema, stockItemSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed } from './support/rbac';

/** A tiny but valid-looking PNG: the api checks the signature and the size, not the pixels. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

/**
 * Categories for stock items (ADR 0048): description, one level of secondary categories, a tile image, and stock items
 * filed under a category.
 */
describe('inventory categories (ADR 0048)', () => {
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

  async function owner() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    return seed.token(userId, org.id);
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', token: string, path: string) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7());
  const category = async (token: string, body: object) =>
    productCategorySchema.parse(
      (await send('post', token, '/catalog/categories').send(body).expect(201)).body,
    );

  it('keeps a description and one level of secondary categories', async () => {
    const token = await owner();
    const food = await category(token, { name: 'Food', description: 'Everything edible' });
    expect(food).toMatchObject({ description: 'Everything edible', parentId: null });
    const rice = await category(token, { name: 'Rice', parentId: food.id });
    expect(rice.parentId).toBe(food.id);

    // Not under a secondary category, not under itself, and a parent can't become secondary.
    await send('post', token, '/catalog/categories')
      .send({ name: 'Basmati', parentId: rice.id })
      .expect(400)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('catalog.category_parent_invalid'),
      );
    await send('patch', token, `/catalog/categories/${food.id}`)
      .send({ parentId: food.id })
      .expect(400);
    const drinks = await category(token, { name: 'Drinks' });
    await send('patch', token, `/catalog/categories/${food.id}`)
      .send({ parentId: drinks.id })
      .expect(400);

    // Empty clears the description; back to top level with null.
    const cleared = productCategorySchema.parse(
      (
        await send('patch', token, `/catalog/categories/${rice.id}`)
          .send({ description: '', parentId: null })
          .expect(200)
      ).body,
    );
    expect(cleared).toMatchObject({ description: null, parentId: null });
  });

  it('stores a tile image checked by its bytes, serves it, and removes it', async () => {
    const token = await owner();
    const food = await category(token, { name: 'Food' });
    const put = (body: Buffer, type: string) =>
      send('put', token, `/catalog/categories/${food.id}/image`)
        .set('Content-Type', type)
        .send(body);

    const withImage = productCategorySchema.parse((await put(PNG, 'image/png').expect(200)).body);
    expect(withImage.imageVersion).not.toBeNull();
    const image = await get(token, `/catalog/categories/${food.id}/image`)
      .buffer(true)
      .expect(200)
      .expect('Content-Type', 'image/png');
    expect(Buffer.compare(image.body as Buffer, PNG)).toBe(0);

    // Declared PNG but not one, or too big, or a type the api doesn't take.
    await put(Buffer.from('not an image at all'), 'image/png').expect(400);
    const tooBig = await put(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), 'image/png').expect(
      413,
    );
    expect(tooBig.body).toMatchObject({ code: 'platform.payload_too_large' });
    await put(PNG, 'image/gif').expect(400);

    const removed = productCategorySchema.parse(
      (await send('delete', token, `/catalog/categories/${food.id}/image`).expect(200)).body,
    );
    expect(removed.imageVersion).toBeNull();
    await get(token, `/catalog/categories/${food.id}/image`).expect(404);
  });

  it('files stock items under an active category only', async () => {
    const token = await owner();
    const food = await category(token, { name: 'Food' });
    const item = stockItemSchema.parse(
      (
        await send('post', token, '/inventory/items')
          .send({ name: 'Basmati rice', unit: 'pc', categoryId: food.id })
          .expect(201)
      ).body,
    );
    expect(item.categoryId).toBe(food.id);

    const old = await category(token, { name: 'Old' });
    await send('patch', token, `/catalog/categories/${old.id}`)
      .send({ archived: true })
      .expect(200);
    await send('patch', token, `/inventory/items/${item.id}`)
      .send({ categoryId: old.id })
      .expect(409)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('catalog.category_archived'),
      );
    await send('patch', token, `/inventory/items/${item.id}`)
      .send({ categoryId: uuidv7() })
      .expect(404);

    const uncategorized = stockItemSchema.parse(
      (
        await send('patch', token, `/inventory/items/${item.id}`)
          .send({ categoryId: null })
          .expect(200)
      ).body,
    );
    expect(uncategorized.categoryId).toBeNull();
  });
});
