import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  notificationListResponseSchema,
  notificationPreferencesResponseSchema,
  stockRequestSchema,
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
 * Stored notifications (ADR 0047): written in the transaction of the change to the people it concerns, never to the
 * person who caused it; each person lists and marks only their own; choices per kind with defaults.
 */
describe('notifications (ADR 0047)', () => {
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

  async function member(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], { locations });
    return { userId, token: await seed.token(userId, org.id) };
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'put', token: string, path: string, body: object = {}) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7()).send(body);
  const post = (token: string, path: string, body: object = {}) => send('post', token, path, body);
  const inbox = async (token: string) =>
    notificationListResponseSchema.parse((await get(token, '/notifications').expect(200)).body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const [mainLocation, branchLocation] = org.locations;
    const owner = await member(org, 'owner');
    const warehouse = async (locationId: string, name: string) =>
      warehouseSchema.parse(
        (await post(owner.token, '/inventory/warehouses', { locationId, name }).expect(201)).body,
      ).id;
    const main = await warehouse(mainLocation, 'Main');
    const branch = await warehouse(branchLocation, 'Store');
    const rice = (
      (
        await post(owner.token, '/inventory/items', {
          name: 'Basmati rice',
          unit: 'pc',
          minQuantity: '20',
        }).expect(201)
      ).body as { id: string }
    ).id;
    await post(owner.token, '/inventory/receipts', {
      warehouseId: main,
      lines: [{ itemId: rice, quantity: '30', unitCost: '2' }],
    }).expect(201);
    return {
      owner,
      main,
      branch,
      rice,
      branchUser: await member(org, 'branch', [branchLocation]),
    };
  }

  it('tells the approvers about a request and the requester about the answer', async () => {
    const s = await setup();
    const created = stockRequestSchema.parse(
      (
        await post(s.branchUser.token, '/stock-requests', {
          fromWarehouseId: s.main,
          toWarehouseId: s.branch,
          lines: [{ itemId: s.rice, quantity: '5' }],
        }).expect(201)
      ).body,
    );
    const ownerInbox = await inbox(s.owner.token);
    expect(ownerInbox.unread).toBe(1);
    expect(ownerInbox.data[0]).toMatchObject({
      kind: 'request_submitted',
      entityType: 'stock_request',
      entityId: created.id,
      params: { number: created.number },
      readAt: null,
    });
    // Not to the one who asked.
    expect((await inbox(s.branchUser.token)).data).toEqual([]);

    await post(s.owner.token, `/stock-requests/${created.id}/approve`, {
      lines: [{ lineId: created.lines[0]!.id, quantity: '5' }],
    }).expect(201);
    const branchInbox = await inbox(s.branchUser.token);
    expect(branchInbox.data.map((n) => n.kind)).toEqual(['request_approved']);

    // Mark one read; someone else's id is not found.
    const id = ownerInbox.data[0]!.id;
    await post(s.branchUser.token, `/notifications/${id}/read`).expect(404);
    await post(s.owner.token, `/notifications/${id}/read`).expect(200);
    expect((await inbox(s.owner.token)).unread).toBe(0);

    await post(s.branchUser.token, '/notifications/read-all').expect(200);
    expect((await inbox(s.branchUser.token)).unread).toBe(0);
  });

  it('tells stock readers once when an item drops to its reorder level', async () => {
    const s = await setup();
    const transfer = (quantity: string) =>
      post(s.owner.token, '/inventory/transfers', {
        fromWarehouseId: s.main,
        toWarehouseId: s.branch,
        lines: [{ itemId: s.rice, quantity }],
      }).expect(201);
    await transfer('5'); // 25: still above 20
    expect((await inbox(s.owner.token)).data.map((n) => n.kind)).not.toContain('low_stock');
    await transfer('10'); // 15: crosses
    await transfer('1'); // 14: already below, no second one
    const low = (await inbox(s.owner.token)).data.filter((n) => n.kind === 'low_stock');
    expect(low).toHaveLength(1);
    expect(low[0]!.params).toMatchObject({
      item: 'Basmati rice',
      warehouse: 'Main',
      quantity: '15',
    });
  });

  it('keeps each person’s choices with defaults', async () => {
    const s = await setup();
    const prefs = notificationPreferencesResponseSchema.parse(
      (await get(s.owner.token, '/notifications/preferences').expect(200)).body,
    ).data;
    expect(prefs.find((p) => p.kind === 'request_submitted')).toEqual({
      kind: 'request_submitted',
      email: true,
      push: false,
    });
    expect(prefs.find((p) => p.kind === 'low_stock')?.email).toBe(false);

    await send('put', s.owner.token, '/notifications/preferences', {
      preferences: [{ kind: 'low_stock', email: true, push: true }],
    }).expect(200);
    const after = notificationPreferencesResponseSchema.parse(
      (await get(s.owner.token, '/notifications/preferences').expect(200)).body,
    ).data;
    expect(after.find((p) => p.kind === 'low_stock')).toEqual({
      kind: 'low_stock',
      email: true,
      push: true,
    });
    // Someone else's are untouched.
    const theirs = notificationPreferencesResponseSchema.parse(
      (await get(s.branchUser.token, '/notifications/preferences').expect(200)).body,
    ).data;
    expect(theirs.find((p) => p.kind === 'low_stock')?.email).toBe(false);
  });
});
