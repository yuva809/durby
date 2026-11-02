import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningAreaSchema,
  diningTableSchema,
  productCategorySchema,
  productSchema,
  sendTicketResponseSchema,
} from '@durby/shared';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
// Like a consuming module (reservations, ADR 0019 §7): only pos's public index.
import { PosFloorReader } from '../src/modules/pos';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/modules/reservations.md → R0.3: pos's read port for other modules. */
describe('PosFloorReader', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let reader: PosFloorReader;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    reader = app.get(PosFloorReader);
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (token: string, path: string, body: unknown) =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);

  const patch = (token: string, path: string, body: unknown) =>
    request(server)
      .patch(`/api/v1${path}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send(body as object);

  /** An organization on `full` with tables at both locations and a product to order. */
  async function restaurant() {
    const org = await seed.org();
    await app.get(EntitlementsAdmin).setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    const owner = await seed.token(userId, org.id);
    const [here, there] = org.locations;
    const terrace = diningAreaSchema.parse(
      (await post(owner, '/pos/areas', { locationId: here, name: 'Terrace' }).expect(201)).body,
    );
    const table = async (locationId: string, body: object) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, ...body }).expect(201)).body,
      );
    const t2 = await table(here, { name: 'T2', seats: 2, sortOrder: 2 });
    const t1 = await table(here, {
      name: 'T1',
      seats: 4,
      sortOrder: 1,
      areaId: terrace.id,
      shape: 'round',
    });
    const old = await table(here, { name: 'Old', seats: 6 });
    await patch(owner, `/pos/tables/${old.id}`, { archived: true }).expect(200);
    const far = await table(there, { name: 'F1', seats: 8 });
    const category = productCategorySchema.parse(
      (await post(owner, '/catalog/categories', { name: 'Food' }).expect(201)).body,
    );
    const soup = productSchema.parse(
      (
        await post(owner, '/catalog/products', {
          categoryId: category.id,
          name: 'Soup',
          price: '6.90',
          taxRate: '7',
        }).expect(201)
      ).body,
    );
    const order = async (tableId: string) =>
      sendTicketResponseSchema.parse(
        (
          await post(owner, `/pos/tables/${tableId}/tickets`, {
            lines: [{ productId: soup.id, quantity: 1 }],
          }).expect(201)
        ).body,
      ).order;
    return { org, owner, here, there, terrace, t1, t2, old, far, order };
  }

  const as = <T>(org: SeededOrg, fn: () => Promise<T>) => seed.as(org.id, fn);

  it('lists a location’s tables in service, in floor order, with their area', async () => {
    const r = await restaurant();
    const tables = await as(r.org, () => reader.tablesAt(r.here));
    expect(tables).toEqual([
      {
        id: r.t1.id,
        locationId: r.here,
        name: 'T1',
        seats: 4,
        areaId: r.terrace.id,
        area: 'Terrace',
        shape: 'round',
        color: 'neutral',
        sortOrder: 1,
        archivedAt: null,
      },
      expect.objectContaining({ id: r.t2.id, name: 'T2', seats: 2, areaId: null, area: null }),
    ]);
    expect((await as(r.org, () => reader.tablesAt(r.there))).map((t) => t.name)).toEqual(['F1']);
  });

  it('finds one table by id, also an archived one, and nothing for unknown ids', async () => {
    const r = await restaurant();
    expect(await as(r.org, () => reader.table(r.t2.id))).toMatchObject({
      id: r.t2.id,
      archivedAt: null,
    });
    const old = await as(r.org, () => reader.table(r.old.id));
    expect(old?.archivedAt).toBeInstanceOf(Date);
    expect(await as(r.org, () => reader.table(uuidv7()))).toBeNull();
    expect(await as(r.org, () => reader.table('not-a-uuid'))).toBeNull();
  });

  it('finds several tables by id, archived ones too, leaving unknown ids out', async () => {
    const r = await restaurant();
    const found = await as(r.org, () => reader.tables([r.old.id, r.t2.id, uuidv7(), 'not-a-uuid']));
    expect(found.map((t) => [t.id, t.archivedAt === null])).toEqual(
      expect.arrayContaining([
        [r.t2.id, true],
        [r.old.id, false],
      ]),
    );
    expect(found).toHaveLength(2);
    expect(await as(r.org, () => reader.tables([]))).toEqual([]);
  });

  it('lists the open orders of a location by table; closing one removes it', async () => {
    const r = await restaurant();
    expect(await as(r.org, () => reader.openOrders(r.here))).toEqual([]);
    const before = Date.now();
    const o1 = await r.order(r.t1.id);
    const o2 = await r.order(r.t2.id);
    await r.order(r.far.id);
    const open = await as(r.org, () => reader.openOrders(r.here));
    expect(open.map((o) => ({ tableId: o.tableId, orderId: o.orderId, covers: o.covers }))).toEqual(
      [
        { tableId: r.t1.id, orderId: o1.id, covers: null },
        { tableId: r.t2.id, orderId: o2.id, covers: null },
      ],
    );
    await patch(r.owner, `/pos/orders/${o2.id}`, { covers: 2 }).expect(200);
    expect((await as(r.org, () => reader.openOrders(r.here))).map((o) => o.covers)).toEqual([
      null,
      2,
    ]);
    for (const o of open) {
      expect(o.openedAt).toBeInstanceOf(Date);
      expect(o.openedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    }
    await post(r.owner, `/pos/orders/${o1.id}/close`, {}).expect(201);
    expect((await as(r.org, () => reader.openOrders(r.here))).map((o) => o.tableId)).toEqual([
      r.t2.id,
    ]);
  });

  it('never reads another tenant’s tables or orders', async () => {
    const a = await restaurant();
    const b = await restaurant();
    await a.order(a.t1.id);
    // Tenant B asking for tenant A's location, table and orders gets nothing (RLS).
    expect(await as(b.org, () => reader.tablesAt(a.here))).toEqual([]);
    expect(await as(b.org, () => reader.table(a.t1.id))).toBeNull();
    expect(await as(b.org, () => reader.tables([a.t1.id]))).toEqual([]);
    expect(await as(b.org, () => reader.openOrders(a.here))).toEqual([]);
    // And A still sees its own.
    expect(await as(a.org, () => reader.openOrders(a.here))).toHaveLength(1);
  });

  it('needs a tenant context', async () => {
    await expect(reader.tablesAt(uuidv7())).rejects.toMatchObject({
      code: 'tenancy.context_missing',
    });
  });

  // R1.3's reservation_tables FK (tenant_id, location_id, table_id) relies on it. It exists since the
  // pos_orders migration as (tenant_id, id, location_id): FKs match a unique index by column set.
  it('dining_tables keeps a unique index on {tenant_id, location_id, id}, for composite FKs', async () => {
    const db = new Client({ connectionString: inject('migrationDatabaseUrl') });
    await db.connect();
    try {
      // A full (non-partial) unique index: what a composite FK may reference.
      const { rows } = await db.query<{ cols: string[] }>(`
        SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = 'dining_tables'::regclass AND i.indisunique AND i.indpred IS NULL
        GROUP BY i.indexrelid`);
      expect(rows.map((r) => r.cols)).toContainEqual(['id', 'location_id', 'tenant_id']);
    } finally {
      await db.end();
    }
  });
});
