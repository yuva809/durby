import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  attentionResponseSchema,
  searchResponseSchema,
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
 * The top bar (ADR 0046): /search and /attention answer only what the caller may see, per role and location, and
 * never across organizations.
 */
describe('top bar search and waiting for me (ADR 0046)', () => {
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
    await seed.member(org.id, userId, org.roles[role], {
      locations,
      displayName: `${role} person`,
    });
    return { userId, token: await seed.token(userId, org.id) };
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const post = (token: string, path: string, body: object = {}) =>
    withIdempotencyKey(auth(request(server).post(`/api/v1${path}`), token), uuidv7()).send(body);
  const search = async (token: string, q: string) =>
    searchResponseSchema.parse(
      (await get(token, `/search?q=${encodeURIComponent(q)}`).expect(200)).body,
    ).data;
  const attention = async (token: string) =>
    attentionResponseSchema.parse((await get(token, '/attention').expect(200)).body);

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
          sku: 'RICE-5',
          minQuantity: '20',
        }).expect(201)
      ).body as { id: string }
    ).id;
    await post(owner.token, '/inventory/receipts', {
      warehouseId: main,
      lines: [{ itemId: rice, quantity: '10', unitCost: '2' }],
    }).expect(201);
    return {
      org,
      owner,
      main,
      branch,
      rice,
      branchUser: await member(org, 'branch', [branchLocation]),
      lager: await member(org, 'warehouse', [mainLocation]),
    };
  }

  it('finds items, requests and staff, each only for those who may see them', async () => {
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

    const ownerHits = await search(s.owner.token, 'rice');
    expect(ownerHits.map((h) => [h.type, h.title])).toContainEqual(['stock_item', 'Basmati rice']);
    expect((await search(s.owner.token, 'RICE-5')).map((h) => h.type)).toContain('stock_item');
    // Partial words, in any order: every word must match.
    expect((await search(s.owner.token, 'rice bas')).map((h) => h.title)).toContain('Basmati rice');
    expect((await search(s.owner.token, 'bas ric')).map((h) => h.title)).toContain('Basmati rice');
    // A warehouse is found by its name, for whoever may read stock at its branch.
    expect((await search(s.owner.token, 'Store')).map((h) => [h.type, h.title])).toContainEqual([
      'warehouse',
      'Store',
    ]);
    expect((await search(s.owner.token, created.number)).map((h) => h.id)).toContain(created.id);
    expect((await search(s.owner.token, 'branch person')).map((h) => h.type)).toContain('member');

    // The branch sees its request but not the staff list.
    expect((await search(s.branchUser.token, created.number)).map((h) => h.id)).toContain(
      created.id,
    );
    expect((await search(s.branchUser.token, 'branch person')).map((h) => h.type)).not.toContain(
      'member',
    );

    // Another organization finds nothing of this one.
    const other = await setup();
    expect(await search(other.owner.token, created.number)).toEqual([]);
    await get(s.owner.token, '/search?q=a').expect(400);
  });

  it('counts what waits for each role and drops it once done', async () => {
    const s = await setup();
    // Rice is below its reorder level (10 ≤ 20) at Main: the owner and the warehouse see it, the branch doesn't.
    expect((await attention(s.owner.token)).data).toContainEqual({ kind: 'low_stock', count: 1 });
    expect((await attention(s.branchUser.token)).data).toEqual([]);

    const created = stockRequestSchema.parse(
      (
        await post(s.branchUser.token, '/stock-requests', {
          fromWarehouseId: s.main,
          toWarehouseId: s.branch,
          lines: [{ itemId: s.rice, quantity: '5' }],
        }).expect(201)
      ).body,
    );
    expect((await attention(s.owner.token)).data).toContainEqual({
      kind: 'requests_to_approve',
      count: 1,
    });
    expect((await attention(s.lager.token)).data.map((i) => i.kind)).not.toContain(
      'requests_to_approve',
    );

    await post(s.owner.token, `/stock-requests/${created.id}/approve`, {
      lines: [{ lineId: created.lines[0]!.id, quantity: '5' }],
    }).expect(201);
    const owner = await attention(s.owner.token);
    expect(owner.data.map((i) => i.kind)).not.toContain('requests_to_approve');
    expect((await attention(s.lager.token)).data).toContainEqual({
      kind: 'transfers_to_pick',
      count: 1,
    });
    expect(owner.total).toBe(owner.data.reduce((sum, i) => sum + i.count, 0));
  });
});
