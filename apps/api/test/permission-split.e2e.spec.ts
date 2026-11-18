import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  orderCustomerSchema,
  roleSchema,
  salesOrderSchema,
  stockItemSchema,
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
 * ADR 0051, route by route: a member holding only one of a split key's replacements gets its route and is refused the
 * siblings; a member still holding a legacy key (stored before the cleanup release) keeps all of them.
 */
describe('split permission keys (ADR 0051)', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const send = (method: 'post' | 'patch' | 'delete', token: string, path: string, body?: unknown) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7()).send(
      body ?? {},
    );

  /** A member whose custom role holds exactly `keys` (stored as given, legacy keys included). */
  async function withKeys(org: SeededOrg, keys: string[]): Promise<string> {
    const userId = await seed.user();
    await seed.member(org.id, userId, await seed.customRole(org.id, keys));
    return seed.token(userId, org.id);
  }
  async function ownerOf(org: SeededOrg): Promise<string> {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    return seed.token(userId, org.id);
  }

  describe('roles: create, edit, delete', () => {
    const READ = ['platform.roles.read', 'platform.users.read'];

    it.each([
      ['platform.roles.create', { post: 201, patch: 403, delete: 403 }],
      ['platform.roles.edit', { post: 403, patch: 200, delete: 403 }],
      ['platform.roles.delete', { post: 403, patch: 403, delete: 200 }],
      // Legacy alias: all three until the cleanup release.
      ['platform.roles.manage', { post: 201, patch: 200, delete: 200 }],
    ] as const)('%s', async (key, expected) => {
      const org = await seed.org();
      const owner = await ownerOf(org);
      const target = roleSchema.parse(
        (
          await send('post', owner, '/roles', { name: `R ${uuidv7()}`, permissions: READ }).expect(
            201,
          )
        ).body,
      ).id;
      const token = await withKeys(org, [...READ, key]);
      await send('post', token, '/roles', { name: `R ${uuidv7()}`, permissions: READ }).expect(
        expected.post,
      );
      await send('patch', token, `/roles/${target}`, { name: `R ${uuidv7()}` }).expect(
        expected.patch,
      );
      const del = await send('delete', token, `/roles/${target}`);
      expect(del.status === 204 ? 200 : del.status).toBe(expected.delete);
    });
  });

  describe('members: edit, delete (remove, deactivate, reactivate)', () => {
    const READ = ['platform.users.read', 'platform.settings.read'];

    it.each([
      ['platform.users.edit', { patch: 200, deactivate: 403, remove: 403 }],
      ['platform.users.delete', { patch: 403, deactivate: 200, remove: 200 }],
      ['platform.users.manage', { patch: 200, deactivate: 200, remove: 200 }],
    ] as const)('%s', async (key, expected) => {
      const org = await seed.org();
      const target = async () => {
        const userId = await seed.user();
        return seed.member(
          org.id,
          userId,
          await seed.customRole(org.id, ['platform.settings.read']),
        );
      };
      const token = await withKeys(org, [...READ, key]);
      const edited = await target();
      await send('patch', token, `/staff/${edited}`, { name: 'Renamed' }).expect(expected.patch);
      const deactivated = await target();
      await send('post', token, `/staff/${deactivated}/deactivate`).expect(expected.deactivate);
      if (expected.deactivate === 200) {
        await send('post', token, `/staff/${deactivated}/reactivate`).expect(200);
      }
      const removed = await target();
      const res = await send('delete', token, `/members/${removed}`);
      expect(res.status === 204 ? 200 : res.status).toBe(expected.remove);
    });
  });

  describe('sales orders and customers', () => {
    async function setup() {
      const org = await seed.org();
      await app.get(EntitlementsAdmin).setPlan(org.id, 'inventory', 'cli.entitlements');
      const owner = await ownerOf(org);
      const warehouse = warehouseSchema.parse(
        (
          await send('post', owner, '/inventory/warehouses', {
            locationId: org.locations[0],
            name: 'Main',
          }).expect(201)
        ).body,
      ).id;
      const item = stockItemSchema.parse(
        (await send('post', owner, '/inventory/items', { name: 'Rice', unit: 'pc' }).expect(201))
          .body,
      );
      const customer = async () =>
        orderCustomerSchema.parse(
          (await send('post', owner, '/orders/customers', { name: `C ${uuidv7()}` }).expect(201))
            .body,
        ).id;
      const order = async () =>
        salesOrderSchema.parse(
          (
            await send('post', owner, '/orders', {
              customerId: await customer(),
              warehouseId: warehouse,
              requestedDate: '2026-12-01',
              lines: [{ itemId: item.id, quantity: '1', unitPrice: '2.00' }],
            }).expect(201)
          ).body,
        ).id;
      return { org, customer, order };
    }
    const ORDERS = ['orders.orders.read', 'orders.customers.read'];

    it.each([
      ['orders.orders.edit', { edit: 200, cancel: 403 }],
      ['orders.orders.delete', { edit: 403, cancel: 201 }],
    ] as const)('%s', async (key, expected) => {
      const s = await setup();
      const token = await withKeys(s.org, [...ORDERS, key]);
      await send('patch', token, `/orders/${await s.order()}`, { note: 'x' }).expect(expected.edit);
      await send('post', token, `/orders/${await s.order()}/cancel`, {}).expect(expected.cancel);
    });

    it.each([
      ['orders.customers.edit', { edit: 200, archive: 403 }],
      // The archive goes through the edit route, so it needs both boxes.
      ['orders.customers.delete', { edit: 403, archive: 403 }],
    ] as const)('%s', async (key, expected) => {
      const s = await setup();
      const token = await withKeys(s.org, [...ORDERS, key]);
      await send('patch', token, `/orders/customers/${await s.customer()}`, { phone: '1' }).expect(
        expected.edit,
      );
      await send('patch', token, `/orders/customers/${await s.customer()}`, {
        archived: true,
      }).expect(expected.archive);
    });

    it('archives and restores with orders.customers.edit and .delete together', async () => {
      const s = await setup();
      const token = await withKeys(s.org, [
        ...ORDERS,
        'orders.customers.edit',
        'orders.customers.delete',
      ]);
      const id = await s.customer();
      await send('patch', token, `/orders/customers/${id}`, { archived: true }).expect(200);
      await send('patch', token, `/orders/customers/${id}`, { archived: false }).expect(200);
    });
  });
});
