import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { productCategorySchema, productSchema } from '@durby/shared';
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

/** ADR 0049: one picture per product, checked by its bytes, served with its content type, audited, isolated. */
describe('product pictures (ADR 0049)', () => {
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
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    return { org, token: await seed.token(userId, org.id) };
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', token: string, path: string) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7());

  async function product(token: string) {
    const food = productCategorySchema.parse(
      (await send('post', token, '/catalog/categories').send({ name: 'Food' }).expect(201)).body,
    );
    return productSchema.parse(
      (
        await send('post', token, '/catalog/products')
          .send({ categoryId: food.id, name: 'Pizza', price: '9.90', taxRate: '7.00' })
          .expect(201)
      ).body,
    );
  }

  it('stores a picture checked by its bytes, serves it, and removes it', async () => {
    const { token } = await owner();
    const pizza = await product(token);
    expect(pizza.imageVersion).toBeNull();

    const put = (body: Buffer, type: string) =>
      send('put', token, `/catalog/products/${pizza.id}/image`)
        .set('Content-Type', type)
        .send(body);
    const withImage = productSchema.parse((await put(PNG, 'image/png').expect(200)).body);
    expect(withImage.imageVersion).not.toBeNull();
    const image = await get(token, `/catalog/products/${pizza.id}/image`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200)
      .expect('Content-Type', 'image/png');
    expect(Buffer.compare(image.body as Buffer, PNG)).toBe(0);

    await put(Buffer.from('not an image at all'), 'image/png').expect(400);
    await put(PNG, 'image/gif').expect(400);
    // Over the body limit the platform answers 413 before the image check, as for category images.
    await put(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), 'image/png').expect(413);

    const removed = productSchema.parse(
      (await send('delete', token, `/catalog/products/${pizza.id}/image`).expect(200)).body,
    );
    expect(removed.imageVersion).toBeNull();
    await get(token, `/catalog/products/${pizza.id}/image`).expect(404);
  });

  it('keeps the picture out of the lists and records the change in the audit log', async () => {
    const { org, token } = await owner();
    const pizza = await product(token);
    await send('put', token, `/catalog/products/${pizza.id}/image`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(200);
    const { data: list } = (await get(token, '/catalog/products').expect(200)).body as {
      data: { imageVersion: string | null }[];
    };
    expect(list.some((p) => p.imageVersion !== null)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(PNG.toString('base64'));

    const rows = await seed.as(org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'product', action: 'catalog.product.updated' },
        select: { entityId: true },
      }),
    );
    expect(rows.map((r) => r.entityId)).toContain(pizza.id);
  });

  it("never shows another organization's picture", async () => {
    const a = await owner();
    const b = await owner();
    const pizza = await product(a.token);
    await send('put', a.token, `/catalog/products/${pizza.id}/image`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(200);
    await get(b.token, `/catalog/products/${pizza.id}/image`).expect(404);
    await send('put', b.token, `/catalog/products/${pizza.id}/image`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(404);
  });
});
