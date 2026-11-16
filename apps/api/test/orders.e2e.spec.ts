import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  orderCustomerListResponseSchema,
  orderCustomerSchema,
  salesOrderListResponseSchema,
  salesOrderSchema,
  stockItemSchema,
  type SystemRole,
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
 * docs/modules/orders.md (ADR 0044): customers and sales orders. Orders sell stock items, leave from a warehouse and
 * are checked at its location; drafts are edited, confirmed and cancelled; each change has a timeline row and an
 * audit row.
 */
describe('orders (ADR 0044)', () => {
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

  async function memberToken(org: SeededOrg, role: SystemRole) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return seed.token(userId, org.id);
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'patch', token: string, path: string, body?: unknown) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7()).send(
      body ?? {},
    );
  const post = (token: string, path: string, body?: unknown) => send('post', token, path, body);
  const patch = (token: string, path: string, body: unknown) => send('patch', token, path, body);

  async function setup(plan: 'inventory' | 'full' = 'inventory') {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const warehouse = warehouseSchema.parse(
      (
        await post(owner, '/inventory/warehouses', {
          locationId: org.locations[0],
          name: 'Main',
        }).expect(201)
      ).body,
    ).id;
    const item = async (name: string, salePrice?: string) =>
      stockItemSchema.parse(
        (await post(owner, '/inventory/items', { name, unit: 'pc', salePrice }).expect(201)).body,
      );
    const customer = orderCustomerSchema.parse(
      (await post(owner, '/orders/customers', { name: 'Lotus Mart', code: 'C-001' }).expect(201))
        .body,
    );
    return { org, owner, warehouse, item, customer };
  }

  const auditActions = (org: SeededOrg, entityId: string) =>
    seed.as(org.id, (db) =>
      db.auditLog.findMany({
        where: { entityId },
        select: { action: true, before: true, after: true },
        orderBy: { id: 'asc' },
      }),
    );

  describe('customers', () => {
    it('adds, edits and archives customers; codes are unique among active ones', async () => {
      const s = await setup();
      await post(s.owner, '/orders/customers', { name: 'Other', code: 'C-001' }).expect(409);
      const edited = orderCustomerSchema.parse(
        (
          await patch(s.owner, `/orders/customers/${s.customer.id}`, {
            phone: '+60 12 345 6789',
            archived: true,
          }).expect(200)
        ).body,
      );
      expect(edited.phone).toBe('+60 12 345 6789');
      expect(edited.archivedAt).not.toBeNull();
      // The code is free again once archived.
      await post(s.owner, '/orders/customers', { name: 'Other', code: 'C-001' }).expect(201);
      const list = orderCustomerListResponseSchema.parse(
        (await get(s.owner, '/orders/customers').expect(200)).body,
      );
      expect(list.data.map((c) => c.name)).toEqual(['Other']);
      // Contact details never reach the audit log.
      const rows = await auditActions(s.org, s.customer.id);
      expect(JSON.stringify(rows)).not.toContain('345 6789');
    });
  });

  describe('sales orders', () => {
    it('creates a numbered draft with exact totals, edits it, confirms and cancels it', async () => {
      const s = await setup();
      const rice = await s.item('Rice 5 kg', '12.90');
      const oil = await s.item('Oil 1 l');
      const created = salesOrderSchema.parse(
        (
          await post(s.owner, '/orders', {
            customerId: s.customer.id,
            warehouseId: s.warehouse,
            requestedDate: '2026-12-01',
            lines: [
              { itemId: rice.id, quantity: '3', unitPrice: '12.90' },
              { itemId: oil.id, quantity: '0.333', unitPrice: '10.00' },
            ],
          }).expect(201)
        ).body,
      );
      expect(created).toMatchObject({
        status: 'draft',
        customerName: 'Lotus Mart',
        locationId: s.org.locations[0],
        requestedDate: '2026-12-01',
        lineCount: 2,
        total: '42.03',
      });
      expect(created.number).toMatch(/^SO-\d{4}-\d{6}$/);
      expect(created.lines.map((l) => l.lineTotal)).toEqual(['38.70', '3.33']);
      expect(created.events.map((e) => e.status)).toEqual(['draft']);

      const edited = salesOrderSchema.parse(
        (
          await patch(s.owner, `/orders/${created.id}`, {
            lines: [{ itemId: rice.id, quantity: '1', unitPrice: '13.00' }],
          }).expect(200)
        ).body,
      );
      expect(edited).toMatchObject({ total: '13.00', lineCount: 1 });

      const confirmed = salesOrderSchema.parse(
        (await post(s.owner, `/orders/${created.id}/confirm`).expect(201)).body,
      );
      expect(confirmed.status).toBe('confirmed');
      await patch(s.owner, `/orders/${created.id}`, { note: 'late' }).expect(409);
      await post(s.owner, `/orders/${created.id}/confirm`).expect(409);

      const cancelled = salesOrderSchema.parse(
        (
          await post(s.owner, `/orders/${created.id}/cancel`, { reason: 'Customer called' }).expect(
            201,
          )
        ).body,
      );
      expect(cancelled.events.map((e) => [e.status, e.note])).toEqual([
        ['draft', null],
        ['confirmed', null],
        ['cancelled', 'Customer called'],
      ]);
      expect((await auditActions(s.org, created.id)).map((r) => r.action)).toEqual([
        'orders.sales_order.created',
        'orders.sales_order.updated',
        'orders.sales_order.status_changed',
        'orders.sales_order.status_changed',
      ]);
    });

    it('confirms at once when asked, and lists orders newest first with filters and pages', async () => {
      const s = await setup();
      const rice = await s.item('Rice');
      const order = (confirm: boolean) =>
        post(s.owner, '/orders', {
          customerId: s.customer.id,
          warehouseId: s.warehouse,
          lines: [{ itemId: rice.id, quantity: '1', unitPrice: '1.00' }],
          confirm,
        }).expect(201);
      const first = salesOrderSchema.parse((await order(false)).body);
      const second = salesOrderSchema.parse((await order(true)).body);
      expect(second.events.map((e) => e.status)).toEqual(['draft', 'confirmed']);

      const page = salesOrderListResponseSchema.parse(
        (await get(s.owner, '/orders?limit=1').expect(200)).body,
      );
      expect(page.data.map((o) => o.id)).toEqual([second.id]);
      const next = salesOrderListResponseSchema.parse(
        (
          await get(
            s.owner,
            `/orders?limit=1&cursor=${encodeURIComponent(page.meta.nextCursor ?? '')}`,
          ).expect(200)
        ).body,
      );
      expect(next.data.map((o) => o.id)).toEqual([first.id]);
      const drafts = salesOrderListResponseSchema.parse(
        (await get(s.owner, '/orders?status=draft').expect(200)).body,
      );
      expect(drafts.data.map((o) => o.id)).toEqual([first.id]);
    });

    it('refuses items with variants, archived customers and unknown warehouses', async () => {
      const s = await setup();
      const rice = await s.item('Rice');
      const base = { customerId: s.customer.id, warehouseId: s.warehouse };
      await post(s.owner, '/orders', {
        ...base,
        lines: [{ itemId: uuidv7(), quantity: '1', unitPrice: '1' }],
      }).expect(404);
      await post(s.owner, '/orders', {
        ...base,
        warehouseId: uuidv7(),
        lines: [{ itemId: rice.id, quantity: '1', unitPrice: '1' }],
      }).expect(404);
      await post(s.owner, '/orders', {
        ...base,
        lines: [
          { itemId: rice.id, quantity: '1', unitPrice: '1' },
          { itemId: rice.id, quantity: '2', unitPrice: '1' },
        ],
      }).expect(400);
      await patch(s.owner, `/orders/customers/${s.customer.id}`, { archived: true }).expect(200);
      await post(s.owner, '/orders', {
        ...base,
        lines: [{ itemId: rice.id, quantity: '1', unitPrice: '1' }],
      }).expect(404);
    });

    it('lets staff read but not create, and hides orders of other organizations', async () => {
      const s = await setup();
      const rice = await s.item('Rice');
      const created = salesOrderSchema.parse(
        (
          await post(s.owner, '/orders', {
            customerId: s.customer.id,
            warehouseId: s.warehouse,
            lines: [{ itemId: rice.id, quantity: '1', unitPrice: '1' }],
          }).expect(201)
        ).body,
      );
      const staff = await memberToken(s.org, 'staff');
      await get(staff, `/orders/${created.id}`).expect(200);
      await post(staff, '/orders', {
        customerId: s.customer.id,
        warehouseId: s.warehouse,
        lines: [{ itemId: rice.id, quantity: '1', unitPrice: '1' }],
      }).expect(403);
      await post(staff, `/orders/${created.id}/cancel`).expect(403);

      const other = await setup();
      await get(other.owner, `/orders/${created.id}`).expect(404);
      const list = salesOrderListResponseSchema.parse(
        (await get(other.owner, '/orders').expect(200)).body,
      );
      expect(list.data).toEqual([]);
    });
  });
});
