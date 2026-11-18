import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  productCategorySchema,
  stockDocumentSchema,
  stockItemListResponseSchema,
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
 * A vendor invoice as one goods receipt (ADR 0049): existing items and new ones in one transaction, all or nothing.
 */
describe('vendor invoice import (ADR 0049)', () => {
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

  async function member(org: SeededOrg, roleId: string) {
    const userId = await seed.user();
    await seed.member(org.id, userId, roleId);
    return seed.token(userId, org.id);
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const post = (token: string, path: string, body: object) =>
    withIdempotencyKey(auth(request(server).post(`/api/v1${path}`), token), uuidv7()).send(body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const owner = await member(org, org.roles.owner);
    const warehouseId = warehouseSchema.parse(
      (
        await post(owner, '/inventory/warehouses', {
          locationId: org.locations[0],
          name: 'Main Warehouse',
        }).expect(201)
      ).body,
    ).id;
    const fish = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Frozen fish' }).expect(201)).body,
    );
    const catfish = (
      (
        await post(owner, '/inventory/items', {
          name: 'Bigi Mama African Catfish 1 x 4kg',
          sku: '1103-002',
          unit: 'pc',
        }).expect(201)
      ).body as { id: string }
    ).id;
    return { org, owner, warehouseId, fish, catfish };
  }

  const items = async (token: string) =>
    stockItemListResponseSchema.parse((await get(token, '/inventory/items').expect(200)).body).data;

  it('books existing and new items as one receipt from the supplier, at the invoice costs', async () => {
    const s = await setup();
    const doc = stockDocumentSchema.parse(
      (
        await post(s.owner, '/inventory/receipts/import', {
          warehouseId: s.warehouseId,
          supplier: 'Bonesca',
          note: 'Order 108666 · 10-11-2026',
          lines: [
            { itemId: s.catfish, quantity: '50', unitCost: '11.00' },
            {
              newItem: {
                name: 'OD Yellow Croakers 5 x 2kg',
                sku: '1971-002',
                unit: 'pc',
                categoryId: s.fish.id,
              },
              quantity: '30',
              unitCost: '41.50',
            },
          ],
        }).expect(201)
      ).body,
    );
    expect(doc).toMatchObject({ kind: 'receipt', supplier: 'Bonesca' });
    expect(doc.lines.map((l) => [l.itemName, l.quantity, l.value])).toEqual([
      ['Bigi Mama African Catfish 1 x 4kg', '50.000', '550.00'],
      ['OD Yellow Croakers 5 x 2kg', '30.000', '1245.00'],
    ]);
    const croakers = (await items(s.owner)).find((i) => i.sku === '1971-002');
    expect(croakers).toMatchObject({ unit: 'pc', categoryId: s.fish.id });
  });

  it('creates nothing when any line fails', async () => {
    const s = await setup();
    await post(s.owner, '/inventory/receipts/import', {
      warehouseId: s.warehouseId,
      lines: [
        { newItem: { name: 'Fresh item', unit: 'pc' }, quantity: '1', unitCost: '1.00' },
        // Same name as an active item: refused, and the first new item rolls back too.
        {
          newItem: { name: 'Bigi Mama African Catfish 1 x 4kg', unit: 'pc' },
          quantity: '1',
          unitCost: '1.00',
        },
      ],
    }).expect(409);
    expect((await items(s.owner)).map((i) => i.name)).not.toContain('Fresh item');
  });

  it('needs inventory.items.edit for new items, not for existing ones', async () => {
    const s = await setup();
    const custom = (
      (
        await post(s.owner, '/roles', {
          name: `Receiver ${uuidv7()}`,
          permissions: ['inventory.stock.read', 'inventory.stock.receive'],
        }).expect(201)
      ).body as { id: string }
    ).id;
    const receiver = await member(s.org, custom);
    await post(receiver, '/inventory/receipts/import', {
      warehouseId: s.warehouseId,
      lines: [{ newItem: { name: 'Not allowed', unit: 'pc' }, quantity: '1', unitCost: '1' }],
    }).expect(403);
    await post(receiver, '/inventory/receipts/import', {
      warehouseId: s.warehouseId,
      lines: [{ itemId: s.catfish, quantity: '2', unitCost: '11' }],
    }).expect(201);
  });
});
