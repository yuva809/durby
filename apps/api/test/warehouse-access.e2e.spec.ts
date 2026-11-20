import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  teamListResponseSchema,
  warehouseListResponseSchema,
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
 * Warehouse Access (ADR 0057): a member limited to some warehouses works only there (lists, receipts), still within
 * their locations; owners and admins set it in Manage Staff, checked against the member's locations and the
 * granting rules.
 */
describe('warehouse access (ADR 0057)', () => {
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

  async function member(org: SeededOrg, roleId: string, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, roleId, locations ? { locations } : {});
    return { userId, token: await seed.token(userId, org.id) };
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'patch', token: string, path: string, body: object) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7()).send(body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const [main, other] = org.locations;
    const owner = await member(org, org.roles.owner);
    const warehouse = async (locationId: string, name: string) =>
      warehouseSchema.parse(
        (await send('post', owner.token, '/inventory/warehouses', { locationId, name }).expect(201))
          .body,
      ).id;
    const dry = await warehouse(main, 'Dry store');
    const cold = await warehouse(main, 'Cold room');
    const branch = await warehouse(other, 'Branch store');
    const item = (
      (
        await send('post', owner.token, '/inventory/items', { name: 'Rice', unit: 'pc' }).expect(
          201,
        )
      ).body as { id: string }
    ).id;
    const manager = await member(org, org.roles.manager, [main]);
    const team = teamListResponseSchema.parse((await get(owner.token, '/staff').expect(200)).body);
    const managerMembership = team.members.find((m) => m.userId === manager.userId)!.membershipId;
    return { org, owner, manager, managerMembership, dry, cold, branch, item };
  }

  it('limits a member to their warehouses for lists and receipts', async () => {
    const s = await setup();
    const updated = await send('patch', s.owner.token, `/staff/${s.managerMembership}`, {
      warehouseIds: [s.dry],
    }).expect(200);
    expect((updated.body as { warehouseIds: string[] }).warehouseIds).toEqual([s.dry]);

    const names = warehouseListResponseSchema
      .parse((await get(s.manager.token, '/inventory/warehouses').expect(200)).body)
      .data.filter((w) => !w.isTransit)
      .map((w) => w.name);
    expect(names).toEqual(['Dry store']);

    const receipt = (warehouseId: string) =>
      send('post', s.manager.token, '/inventory/receipts', {
        warehouseId,
        lines: [{ itemId: s.item, quantity: '1', unitCost: '1.00' }],
      });
    await receipt(s.dry).expect(201);
    const refused = await receipt(s.cold).expect(404);
    expect((refused.body as { code: string }).code).toBe('inventory.warehouse_not_found');

    // Back to every warehouse at their location.
    await send('patch', s.owner.token, `/staff/${s.managerMembership}`, {
      warehouseIds: null,
    }).expect(200);
    await receipt(s.cold).expect(201);
  });

  it('shows a branch manager the warehouse that supplies their branch, read only', async () => {
    const s = await setup();
    const [main, other] = s.org.locations;
    // A depot at the other location that supplies the manager's branch (ADR 0067).
    const depot = warehouseSchema.parse(
      (
        await send('post', s.owner.token, '/inventory/warehouses', {
          locationId: other,
          name: 'Depot',
        }).expect(201)
      ).body,
    );
    await send('patch', s.owner.token, `/inventory/warehouses/${depot.id}`, {
      suppliesLocationIds: [main],
    }).expect(200);

    const names = warehouseListResponseSchema
      .parse((await get(s.manager.token, '/inventory/warehouses').expect(200)).body)
      .data.filter((w) => !w.isTransit)
      .map((w) => w.name)
      .sort();
    // Their own warehouses and the depot that supplies them; not the store at the other branch.
    expect(names).toEqual(['Cold room', 'Depot', 'Dry store']);
  });

  it('only allows warehouses at the member’s locations, and only what the actor may give', async () => {
    const s = await setup();
    const elsewhere = await send('patch', s.owner.token, `/staff/${s.managerMembership}`, {
      warehouseIds: [s.branch],
    }).expect(400);
    expect((elsewhere.body as { code: string }).code).toBe('rbac.warehouse_invalid');

    // An admin limited to the dry store can't give the cold room, nor "every warehouse".
    const admin = await member(s.org, s.org.roles.admin);
    const team = teamListResponseSchema.parse(
      (await get(s.owner.token, '/staff').expect(200)).body,
    );
    const adminMembership = team.members.find((m) => m.userId === admin.userId)!.membershipId;
    await send('patch', s.owner.token, `/staff/${adminMembership}`, {
      warehouseIds: [s.dry],
    }).expect(200);
    const adminToken = await seed.token(admin.userId, s.org.id);
    await send('patch', adminToken, `/staff/${s.managerMembership}`, {
      warehouseIds: [s.cold],
    }).expect(403);
    await send('patch', adminToken, `/staff/${s.managerMembership}`, {
      warehouseIds: [s.dry],
    }).expect(200);
  });
});
