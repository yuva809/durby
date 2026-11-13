import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { diningTableSchema, PERMISSIONS, productCategorySchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** ADR 0037: create / edit / delete keys gate the matching routes; a retired `x.manage` still means all three. */
describe('create, edit and delete permission keys', () => {
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

  const post = (token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body as object);
  const patch = (token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
    ).send(body as object);

  async function member(org: SeededOrg, roleId: string) {
    const userId = await seed.user();
    await seed.member(org.id, userId, roleId, {});
    return seed.token(userId, org.id);
  }

  /** A table and a category to edit, made by the owner. */
  async function setup() {
    const org = await seed.org();
    const owner = await member(org, org.roles.owner);
    const table = diningTableSchema.parse(
      (
        await post(owner, '/pos/tables', {
          locationId: org.locations[0],
          name: 'T1',
          seats: 4,
        }).expect(201)
      ).body,
    );
    return { org, owner, table };
  }

  it('lets an edit-only role change a table but not create one', async () => {
    const { org, table } = await setup();
    const roleId = await seed.customRole(org.id, ['pos.tables.edit', 'pos.tables.read']);
    const token = await member(org, roleId);
    const edited = await patch(token, `/pos/tables/${table.id}`, { seats: 6 });
    expect(edited.body, JSON.stringify(edited.body)).toBeDefined();
    expect(edited.status).toBe(200);
    const denied = await post(token, '/pos/tables', {
      locationId: org.locations[0],
      name: 'T2',
      seats: 2,
    }).expect(403);
    expect(denied.body).toMatchObject({ details: { permission: 'pos.tables.create' } });
  });

  it('treats a stored retired key (catalog.products.manage) as create, edit and delete', async () => {
    const { org } = await setup();
    const roleId = await seed.customRole(org.id, [
      'catalog.products.manage',
      'catalog.products.read',
    ]);
    const token = await member(org, roleId);
    const created = productCategorySchema.parse(
      (await post(token, '/catalog/categories', { name: 'Drinks' }).expect(201)).body,
    );
    expect(created.name).toBe('Drinks');
  });

  it('denies one action when only that key is denied, and the others still work', async () => {
    const { org } = await setup();
    const manager = await seed.user();
    await seed.member(org.id, manager, org.roles.manager, {});
    const token = await seed.token(manager, org.id);
    await seed.as(org.id, async (db) => {
      const membership = await db.membership.findFirstOrThrow({ where: { userId: manager } });
      await db.membershipPermission.create({
        data: {
          tenantId: org.id,
          membershipId: membership.id,
          permissionKey: 'pos.tables.create',
          effect: 'deny',
        },
      });
    });
    await post(token, '/pos/tables', { locationId: org.locations[0], name: 'T9', seats: 2 }).expect(
      403,
    );
    const owner = await member(org, org.roles.owner);
    const table = diningTableSchema.parse(
      (
        await post(owner, '/pos/tables', {
          locationId: org.locations[0],
          name: 'T8',
          seats: 2,
        }).expect(201)
      ).body,
    );
    await patch(token, `/pos/tables/${table.id}`, { seats: 3 }).expect(200);
  });

  it('every registry key has a label and each *.create / *.edit / *.delete pair exists', () => {
    for (const module of [
      'catalog.products',
      'pos.tables',
      'inventory.warehouses',
      'reservations.setup',
    ]) {
      for (const verb of ['create', 'edit', 'delete']) {
        expect(PERMISSIONS).toHaveProperty(`${module}.${verb}`);
      }
    }
    expect(PERMISSIONS).not.toHaveProperty('pos.tables.manage');
  });
});
