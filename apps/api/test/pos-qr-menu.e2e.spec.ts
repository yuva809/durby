import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableListResponseSchema,
  diningTableSchema,
  type PlanKey,
  productCategorySchema,
  publicMenuSchema,
  type SystemRole,
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

/** docs/modules/pos.md → QR menu (ADR 0026): the public table menu and its token. */
describe('pos QR menu', () => {
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

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: unknown = {}, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body as object);
  const patch = (token: string, path: string, body: unknown) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
    ).send(body as object);
  const menu = (link: string) => request(server).get(`/api/v1/public/menu/${link}`);

  /** A restaurant with a menu (one archived dish, one empty category) and a table. */
  async function restaurant(name = 'Bistro', plan: PlanKey = 'full') {
    const org = await seed.org(name);
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const category = async (n: string) =>
      productCategorySchema.parse(
        (await post(owner, '/catalog/categories', { name: n }).expect(201)).body,
      ).id;
    const food = await category('Food');
    await category('Empty');
    const product = async (n: string, price: string, extra: object = {}) =>
      (
        await post(owner, '/catalog/products', {
          categoryId: food,
          name: n,
          price,
          taxRate: '7',
          ...extra,
        }).expect(201)
      ).body as { id: string };
    await product('Soup', '6.90', { description: 'Tomato' });
    const old = await product('Old dish', '9.00');
    await patch(owner, `/catalog/products/${old.id}`, { archived: true }).expect(200);
    const table = diningTableSchema.parse(
      (
        await post(owner, '/pos/tables', {
          locationId: org.locations[0],
          name: 'T5',
          seats: 4,
        }).expect(201)
      ).body,
    );
    return { org, owner, table, link: `${org.id}.${table.menuCode}` };
  }

  it('gives every table a 24-character code that only table readers see', async () => {
    const r = await restaurant();
    expect(r.table.menuCode).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const listed = diningTableListResponseSchema.parse(
      (await get(r.owner, '/pos/tables').expect(200)).body,
    );
    expect(listed.data[0]?.menuCode).toBe(r.table.menuCode);
  });

  it('shows guests the menu without signing in: names, descriptions and prices only', async () => {
    const r = await restaurant();
    const res = await menu(r.link).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = publicMenuSchema.parse(res.body);
    expect(body).toEqual({
      name: 'Bistro',
      logo: null,
      tableName: 'T5',
      currency: 'EUR',
      locale: 'en',
      categories: [
        { name: 'Food', products: [{ name: 'Soup', description: 'Tomato', price: '6.90' }] },
      ],
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(r.table.id);
    expect(text).not.toContain('taxRate');
  });

  it("uses the bill header's name and logo when set", async () => {
    const r = await restaurant();
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    await withIdempotencyKey(
      request(server).put('/api/v1/settings/pos.billHeader').auth(r.owner, { type: 'bearer' }),
    )
      .send({ value: { logo, name: 'Bay Leaf', phone: null, email: null, website: null } })
      .expect(200);
    const body = publicMenuSchema.parse((await menu(r.link).expect(200)).body);
    expect(body).toMatchObject({ name: 'Bay Leaf', logo });
  });

  it('a new code stops the old one; only table managers renew, and it is audited without the token', async () => {
    const r = await restaurant();
    const waiter = await memberToken(r.org, 'waiter');
    await post(waiter, `/pos/tables/${r.table.id}/menu-token`).expect(403);
    const key = uuidv7();
    const renewed = diningTableSchema.parse(
      (await post(r.owner, `/pos/tables/${r.table.id}/menu-token`, {}, key).expect(201)).body,
    );
    expect(renewed.menuCode).not.toBe(r.table.menuCode);
    // A replay returns the same new code.
    const again = diningTableSchema.parse(
      (await post(r.owner, `/pos/tables/${r.table.id}/menu-token`, {}, key).expect(201)).body,
    );
    expect(again.menuCode).toBe(renewed.menuCode);
    await menu(r.link).expect(404);
    await menu(`${r.org.id}.${renewed.menuCode}`).expect(200);
    const rows = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.dining_table.menu_token_rotated' } }),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(renewed.menuCode);
  });

  it('answers 404 for archived tables, bad and foreign links, and organizations without pos', async () => {
    const r = await restaurant();
    const other = await restaurant('Other');
    // Another organization's id with this token: read in that tenant, so nothing is found.
    const foreign = await menu(`${other.org.id}.${r.table.menuCode}`).expect(404);
    expect(foreign.body).toMatchObject({ code: 'pos.menu_not_found' });
    await menu(`${uuidv7()}.${r.table.menuCode}`).expect(404);
    await menu('not-a-link').expect(404);
    await menu(`${r.org.id}.short`).expect(404);

    await patch(r.owner, `/pos/tables/${r.table.id}`, { archived: true }).expect(200);
    await menu(r.link).expect(404);

    const basic = await restaurant('Basic');
    await entitlements.setPlan(basic.org.id, 'inventory', 'cli.entitlements');
    await menu(basic.link).expect(404);
  });
});
