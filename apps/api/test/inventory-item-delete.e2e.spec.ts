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
    return { org, token, warehouse, item };
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
});
