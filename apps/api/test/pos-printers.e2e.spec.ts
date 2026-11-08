import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { billLayoutSchema, printerListResponseSchema, printerSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/platform/database';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** ADR 0033: printers as a list per location, each printing bills and/or the tickets of chosen stations. */
describe('pos printers', () => {
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

  async function org(): Promise<{ org: SeededOrg; owner: string }> {
    const o = await seed.org();
    await entitlements.setPlan(o.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(o.id, userId, o.roles.owner);
    return { org: o, owner: await seed.token(userId, o.id) };
  }

  async function member(o: SeededOrg, role: 'waiter' | 'staff' | 'admin', locations?: string[]) {
    const userId = await seed.user();
    await seed.member(o.id, userId, o.roles[role], locations ? { locations } : {});
    return seed.token(userId, o.id);
  }

  const printer = (locationId: string, overrides: object = {}) => ({
    locationId,
    name: 'Bar',
    host: '192.168.64.20',
    port: 9100,
    widthDots: 576,
    cutter: true,
    imageMode: 'gsV0',
    printsBills: false,
    stations: ['bar'],
    ...overrides,
  });

  const send = (
    token: string,
    method: 'post' | 'patch',
    path: string,
    body: object,
    key = uuidv7(),
  ) =>
    withIdempotencyKey(
      request(server)[method](`/api/v1/pos/printers${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body);

  const create = async (token: string, body: object) =>
    printerSchema.parse((await send(token, 'post', '', body).expect(201)).body);

  const list = async (token: string, locationId: string) =>
    printerListResponseSchema.parse(
      (
        await request(server)
          .get(`/api/v1/pos/printers?locationId=${locationId}`)
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body,
    ).data;

  it('adds a printer switched off, with its stations, and audits it', async () => {
    const { org: o, owner } = await org();
    const bar = await create(owner, printer(o.locations[0], { stations: ['kitchen', 'bar'] }));
    expect(bar).toMatchObject({
      name: 'Bar',
      enabled: false,
      printsBills: false,
      stations: ['bar', 'kitchen'],
      archivedAt: null,
    });
    // `enabled` isn't accepted on create: a new printer never prints before it is switched on.
    await send(owner, 'post', '', {
      ...printer(o.locations[0], { name: 'X' }),
      enabled: true,
    }).expect(400);
    expect(await list(owner, o.locations[0])).toEqual([bar]);
    expect(await list(owner, o.locations[1])).toEqual([]);

    const audit = await seed.as(o.id, (db) =>
      db.auditLog.findMany({ where: { entityId: bar.id }, select: { action: true, after: true } }),
    );
    expect(audit).toEqual([
      {
        action: 'pos.printer.created',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matcher
        after: expect.objectContaining({
          name: 'Bar',
          enabled: false,
          stations: ['bar', 'kitchen'],
        }),
      },
    ]);
  });

  it('switches a printer on, changes its stations and bills, and archives it', async () => {
    const { org: o, owner } = await org();
    const p = await create(owner, printer(o.locations[0]));
    const on = printerSchema.parse(
      (
        await send(owner, 'patch', `/${p.id}`, {
          enabled: true,
          printsBills: true,
          stations: ['kitchen'],
        }).expect(200)
      ).body,
    );
    expect(on).toMatchObject({ enabled: true, printsBills: true, stations: ['kitchen'] });
    await send(owner, 'patch', `/${p.id}`, { stations: [] }).expect(200);
    await send(owner, 'patch', `/${p.id}`, {}).expect(400);

    const archived = printerSchema.parse(
      (await send(owner, 'post', `/${p.id}/archive`, {}).expect(200)).body,
    );
    expect(archived.enabled).toBe(false);
    expect(archived.archivedAt).not.toBeNull();
    expect(await list(owner, o.locations[0])).toEqual([]);
    await send(owner, 'patch', `/${p.id}`, { enabled: true }).expect(404);
    await send(owner, 'post', `/${p.id}/archive`, {}).expect(404);

    const actions = await seed.as(o.id, (db) =>
      db.auditLog.findMany({
        where: { entityId: p.id },
        orderBy: { createdAt: 'asc' },
        select: { action: true },
      }),
    );
    expect(actions.map((a) => a.action)).toEqual([
      'pos.printer.created',
      'pos.printer.updated',
      'pos.printer.updated',
      'pos.printer.archived',
    ]);
  });

  it('keeps names unique per location among printers in use, ignoring case', async () => {
    const { org: o, owner } = await org();
    const first = await create(owner, printer(o.locations[0]));
    const taken = await send(owner, 'post', '', printer(o.locations[0], { name: 'bar' })).expect(
      409,
    );
    expect(taken.body).toMatchObject({ code: 'pos.printer_name_taken' });
    // Another location, or after archiving: free again.
    await create(owner, printer(o.locations[1]));
    const kitchen = await create(owner, printer(o.locations[0], { name: 'Kitchen' }));
    await send(owner, 'patch', `/${kitchen.id}`, { name: 'BAR' }).expect(409);
    await send(owner, 'post', `/${first.id}/archive`, {}).expect(200);
    await create(owner, printer(o.locations[0]));
  });

  it('lets one printer serve both stations and a station print on several printers', async () => {
    const { org: o, owner } = await org();
    await create(owner, printer(o.locations[0], { name: 'Both', stations: ['kitchen', 'bar'] }));
    await create(owner, printer(o.locations[0], { name: 'Bar 2', stations: ['bar'] }));
    const bar = (await list(owner, o.locations[0])).filter((p) => p.stations.includes('bar'));
    expect(bar.map((p) => p.name)).toEqual(['Bar 2', 'Both']);
  });

  it('refuses addresses, ports, widths and stations outside the rules', async () => {
    const { org: o, owner } = await org();
    for (const bad of [
      { host: '8.8.8.8' },
      { host: 'printer.local' },
      { port: 80 },
      { widthDots: 380 },
      { stations: ['pizza'] },
      { stations: ['bar', 'bar'] },
      { name: ' ' },
      { name: 'x'.repeat(61) },
    ]) {
      await send(owner, 'post', '', printer(o.locations[0], bad)).expect(400);
    }
  });

  it('is for Owner and Admin to change; tills get the printers with the bill layout', async () => {
    const { org: o, owner } = await org();
    const admin = await member(o, 'admin');
    const waiter = await member(o, 'waiter', [o.locations[0]]);
    const p = await create(admin, printer(o.locations[0]));
    await send(waiter, 'post', '', printer(o.locations[0], { name: 'W' })).expect(403);
    await send(waiter, 'patch', `/${p.id}`, { enabled: true }).expect(403);

    // The till reads every printer that isn't archived, switched on or off (a test print may come first).
    const layout = billLayoutSchema.parse(
      (
        await request(server)
          .get(`/api/v1/pos/bill-layout?locationId=${o.locations[0]}`)
          .auth(waiter, { type: 'bearer' })
          .expect(200)
      ).body,
    );
    expect(layout.printerList).toEqual([p]);
    await send(owner, 'post', `/${p.id}/archive`, {}).expect(200);
    const after = billLayoutSchema.parse(
      (
        await request(server)
          .get(`/api/v1/pos/bill-layout?locationId=${o.locations[0]}`)
          .auth(waiter, { type: 'bearer' })
          .expect(200)
      ).body,
    );
    expect(after.printerList).toEqual([]);
  });

  it('replays a create with the same Idempotency-Key instead of adding twice', async () => {
    const { org: o, owner } = await org();
    const key = uuidv7();
    const first = (await send(owner, 'post', '', printer(o.locations[0]), key).expect(201))
      .body as {
      id: string;
    };
    const again = (await send(owner, 'post', '', printer(o.locations[0]), key).expect(201))
      .body as {
      id: string;
    };
    expect(again.id).toBe(first.id);
    expect(await list(owner, o.locations[0])).toHaveLength(1);
  });

  it("never shows or changes another organization's printers", async () => {
    const a = await org();
    const b = await org();
    const p = await create(a.owner, printer(a.org.locations[0]));
    await request(server)
      .get(`/api/v1/pos/printers?locationId=${a.org.locations[0]}`)
      .auth(b.owner, { type: 'bearer' })
      .expect(404);
    await send(b.owner, 'post', '', printer(a.org.locations[0])).expect(404);
    await send(b.owner, 'patch', `/${p.id}`, { enabled: true }).expect(404);
    await send(b.owner, 'post', `/${p.id}/archive`, {}).expect(404);
    expect(await seed.as(b.org.id, (db) => db.posPrinter.count())).toBe(0);
    expect(await seed.as(b.org.id, (db) => db.posPrinterStation.count())).toBe(0);
  });

  it("copies each location's version 1 bill printer into a printer (migration pos_printers)", async () => {
    const { org: o, owner } = await org();
    const put = (value: object, locationId?: string) =>
      withIdempotencyKey(
        request(server)
          .put(`/api/v1/settings/pos.printers${locationId ? `?locationId=${locationId}` : ''}`)
          .auth(owner, { type: 'bearer' }),
        uuidv7(),
      )
        .send({ value })
        .expect(200);
    const bill = {
      host: '192.168.64.20',
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
    };
    await put({ bill });
    await put(
      { bill: { ...bill, host: '192.168.64.21', port: 9101, imageMode: 'escStar' } },
      o.locations[0],
    );

    // The migration's own block, for this organization only (the test database holds others).
    const sql = readFileSync(
      join(__dirname, '../prisma/migrations/20261108140000_pos_printers/migration.sql'),
      'utf8',
    );
    const block = sql
      .slice(sql.indexOf('DO $$'))
      .replace(
        'SELECT "id" FROM "organizations" ORDER BY "id"',
        `SELECT "id" FROM "organizations" WHERE "id" = '${o.id}'`,
      );
    const raw = app.get(PrismaService);
    await raw.$executeRawUnsafe(block);
    await raw.$executeRawUnsafe(block); // idempotent

    const here = await list(owner, o.locations[0]);
    const there = await list(owner, o.locations[1]);
    expect(here).toEqual([
      expect.objectContaining({
        name: '192.168.64.21:9101',
        host: '192.168.64.21',
        port: 9101,
        imageMode: 'escStar',
        enabled: true,
        printsBills: true,
        stations: [],
      }),
    ]);
    // The other location inherits the organization's value.
    expect(there).toEqual([
      expect.objectContaining({ host: '192.168.64.20', enabled: true, printsBills: true }),
    ]);
    const audit = await seed.as(o.id, (db) =>
      db.auditLog.findMany({
        where: { action: 'pos.printer.created' },
        select: { actorType: true, actorSystem: true },
      }),
    );
    expect(audit).toEqual([
      { actorType: 'system', actorSystem: 'migration' },
      { actorType: 'system', actorSystem: 'migration' },
    ]);
  });
});
