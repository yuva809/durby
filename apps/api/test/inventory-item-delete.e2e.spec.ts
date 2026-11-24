import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { warehouseSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed } from './support/rbac';

/** Deleting an inventory item: only one without stock history (ADR 0027); the others are archived. */
describe('deleting an inventory item', () => {
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

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'delete', token: string, path: string, body?: object) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7()).send(
      body ?? {},
    );

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner, {});
    const token = await seed.token(userId, org.id);
    const warehouse = warehouseSchema.parse(
      (
        await send('post', token, '/inventory/warehouses', {
          locationId: org.locations[0],
          name: 'Main',
        }).expect(201)
      ).body,
    );
    const item = async (name: string) =>
      (
        (await send('post', token, '/inventory/items', { name, unit: 'pc' }).expect(201)).body as {
          id: string;
        }
      ).id;
    const member = async (role: string) => {
      const id = await seed.user();
      await seed.member(org.id, id, role, {});
      return seed.token(id, org.id);
    };
    return { org, token, warehouse, item, member };
  }

  it('deletes an item that has never been stocked, and audits it', async () => {
    const s = await setup();
    const id = await s.item('Spare box');
    await send('delete', s.token, `/inventory/items/${id}`).expect(204);
    const rows = await seed.as(s.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'inventory.stock_item.deleted', entityId: id } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to delete an item with stock history; it can be archived instead', async () => {
    const s = await setup();
    const id = await s.item('Rice');
    await send('post', s.token, '/inventory/receipts', {
      warehouseId: s.warehouse.id,
      lines: [{ itemId: id, quantity: '5', unitCost: '1.00' }],
    }).expect(201);
    const refused = await send('delete', s.token, `/inventory/items/${id}`).expect(409);
    expect((refused.body as { code: string }).code).toBe('inventory.item_in_use');
  });

  it('deletes an item with its whole history for owners only, keeping other items and documents (ADR 0079)', async () => {
    const s = await setup();
    const rice = await s.item('Rice');
    const beans = await s.item('Beans');
    // One receipt with both items, then a waste adjustment of rice alone.
    await send('post', s.token, '/inventory/receipts', {
      warehouseId: s.warehouse.id,
      lines: [
        { itemId: rice, quantity: '5', unitCost: '1.00' },
        { itemId: beans, quantity: '3', unitCost: '2.00' },
      ],
    }).expect(201);
    await send('post', s.token, '/inventory/adjustments', {
      warehouseId: s.warehouse.id,
      reason: 'waste',
      lines: [{ itemId: rice, quantity: '-1' }],
    }).expect(201);

    // Not for an admin: owners only.
    const admin = await s.member(s.org.roles.admin);
    await send('post', admin, `/inventory/items/${rice}/purge`).expect(403);

    await send('post', s.token, `/inventory/items/${rice}/purge`).expect(204);
    const items = (await get(s.token, '/inventory/items?includeArchived=true').expect(200))
      .body as {
      data: { name: string }[];
    };
    expect(items.data.map((i) => i.name)).toEqual(['Beans']);
    const stock = (await get(s.token, `/inventory/stock?warehouseId=${s.warehouse.id}`).expect(200))
      .body as { data: { itemName: string; quantity: string }[] };
    expect(stock.data.map((l) => [l.itemName, l.quantity])).toEqual([['Beans', '3.000']]);
    // The shared receipt stays with beans; the waste document, empty now, is gone.
    const docs = (await get(s.token, '/inventory/documents').expect(200)).body as {
      data: { kind: string; lineCount: number }[];
    };
    expect(docs.data.map((d) => [d.kind, d.lineCount])).toEqual([['receipt', 1]]);
    const audited = await seed.as(s.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'inventory.stock_item.purged', entityId: rice } }),
    );
    expect(audited).toHaveLength(1);
    await send('post', s.token, `/inventory/items/${rice}/purge`).expect(404);

    // Another organization's item: not found.
    const other = await setup();
    await send('post', other.token, `/inventory/items/${beans}/purge`).expect(404);
  });

  it('refuses to purge an item in a bill of materials (change that first)', async () => {
    const s = await setup();
    const flour = await s.item('Flour');
    const bread = await s.item('Bread');
    await send('post', s.token, '/inventory/receipts', {
      warehouseId: s.warehouse.id,
      lines: [{ itemId: flour, quantity: '5', unitCost: '1.00' }],
    }).expect(201);
    await withIdempotencyKey(
      auth(request(server).put(`/api/v1/inventory/boms/${bread}`), s.token),
      uuidv7(),
    )
      .send({ outputQuantity: '1', lines: [{ itemId: flour, quantity: '0.5' }] })
      .expect(200);
    const refused = await send('post', s.token, `/inventory/items/${flour}/purge`).expect(409);
    expect(refused.body).toMatchObject({ code: 'inventory.item_purge_refused' });
  });
});
