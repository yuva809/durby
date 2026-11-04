import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  floorResponseSchema,
  orderSchema,
  productCategorySchema,
  productSchema,
  sendTicketResponseSchema,
  stationBoardResponseSchema,
  stationTicketSchema,
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

/** docs/modules/pos.md → Kitchen and bar screens (ADR 0026): boards, moves, served, access. */
describe('pos kitchen and bar screens', () => {
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

  async function memberToken(org: SeededOrg, role: SystemRole, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
  const post = (token: string, path: string, body: unknown = {}, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body as object);

  /** Soup in a kitchen category, beer in a bar category, a table at each location, one order sent. */
  async function restaurant() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const category = async (name: string, station: string) =>
      productCategorySchema.parse(
        (await post(owner, '/catalog/categories', { name, station }).expect(201)).body,
      ).id;
    const product = async (categoryId: string, name: string) =>
      productSchema.parse(
        (
          await post(owner, '/catalog/products', {
            categoryId,
            name,
            price: '5.00',
            taxRate: '7',
          }).expect(201)
        ).body,
      ).id;
    const soup = await product(await category('Food', 'kitchen'), 'Soup');
    const beer = await product(await category('Drinks', 'bar'), 'Beer');
    const table = async (locationId: string, name: string) =>
      diningTableSchema.parse(
        (await post(owner, '/pos/tables', { locationId, name, seats: 4 }).expect(201)).body,
      ).id;
    const here = org.locations[0];
    const t1 = await table(here, 'T1');
    const t9 = await table(org.locations[1], 'T9');
    const sent = sendTicketResponseSchema.parse(
      (
        await post(owner, `/pos/tables/${t1}/tickets`, {
          lines: [
            { productId: soup, quantity: 2, note: 'no salt' },
            { productId: beer, quantity: 1 },
          ],
        }).expect(201)
      ).body,
    );
    const [kitchenTicket, barTicket] = sent.ticketIds;
    return {
      org,
      owner,
      here,
      soup,
      beer,
      t1,
      t9,
      order: sent.order,
      kitchenTicket: kitchenTicket!,
      barTicket: barTicket!,
    };
  }

  const board = async (token: string, station: string, locationId: string) =>
    stationBoardResponseSchema.parse(
      (await get(token, `/pos/stations/${station}/tickets?locationId=${locationId}`).expect(200))
        .body,
    ).data;
  const move = (token: string, station: string, ticketId: string, status: string, key?: string) =>
    post(token, `/pos/stations/${station}/tickets/${ticketId}/status`, { status }, key);

  it('shows each station only its own tickets, at the location, oldest first', async () => {
    const r = await restaurant();
    const cook = await memberToken(r.org, 'kitchen');
    const bartender = await memberToken(r.org, 'bar');
    const kitchen = await board(cook, 'kitchen', r.here);
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0]).toMatchObject({
      id: r.kitchenTicket,
      orderNumber: r.order.number,
      tableName: 'T1',
      sequence: 1,
      kind: 'order',
      status: 'new',
      lines: [{ productName: 'Soup', quantity: 2, note: 'no salt' }],
    });
    expect((await board(bartender, 'bar', r.here)).map((t) => t.id)).toEqual([r.barTicket]);
    expect(await board(cook, 'kitchen', r.org.locations[1])).toEqual([]);
    // No prices on a screen.
    expect(JSON.stringify(kitchen)).not.toContain('5.00');
  });

  it('moves a ticket new → preparing → ready → served, and an undo from ready', async () => {
    const r = await restaurant();
    const cook = await memberToken(r.org, 'kitchen');
    const step = async (status: string) =>
      stationTicketSchema.parse(
        (await move(cook, 'kitchen', r.kitchenTicket, status).expect(201)).body,
      );
    expect((await step('preparing')).status).toBe('preparing');
    expect((await step('ready')).status).toBe('ready');
    expect((await step('preparing')).status).toBe('preparing');
    expect((await step('ready')).status).toBe('ready');
    const served = await step('served');
    expect(served.status).toBe('served');
    // Served stays on the board for a while (undo), then it is history.
    expect((await board(cook, 'kitchen', r.here))[0]?.status).toBe('served');
    // Repeating the current status changes nothing; going back from served is not a move.
    await step('served');
    const refused = await move(cook, 'kitchen', r.kitchenTicket, 'preparing').expect(409);
    expect(refused.body).toMatchObject({ code: 'pos.ticket_status_invalid' });
    const rows = await seed.as(r.org.id, (db) =>
      db.posTicketStatusChange.findMany({
        where: { ticketId: r.kitchenTicket },
        orderBy: { id: 'asc' },
      }),
    );
    expect(rows.map((row) => row.status)).toEqual([
      'preparing',
      'ready',
      'preparing',
      'ready',
      'served',
    ]);
  });

  it('replays a repeated move instead of writing it twice; audits each change', async () => {
    const r = await restaurant();
    const cook = await memberToken(r.org, 'kitchen');
    const key = uuidv7();
    await move(cook, 'kitchen', r.kitchenTicket, 'ready', key).expect(201);
    await move(cook, 'kitchen', r.kitchenTicket, 'ready', key).expect(201);
    const audits = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({ where: { action: 'pos.kitchen_ticket.status_changed' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ before: { status: 'new' }, after: { status: 'ready' } });
  });

  it('lets a void ticket only be seen', async () => {
    const r = await restaurant();
    const lineId = r.order.tickets[0]!.lines[0]!.id;
    const voided = sendTicketResponseSchema.parse(
      (
        await post(r.owner, `/pos/orders/${r.order.id}/voids`, {
          lines: [{ lineId, quantity: 1 }],
        }).expect(201)
      ).body,
    );
    const cook = await memberToken(r.org, 'kitchen');
    await move(cook, 'kitchen', voided.ticketId, 'preparing').expect(409);
    await move(cook, 'kitchen', voided.ticketId, 'served').expect(201);
  });

  it('keeps stations and locations apart: wrong station, role or location is 404 or 403', async () => {
    const r = await restaurant();
    const cook = await memberToken(r.org, 'kitchen');
    const bartender = await memberToken(r.org, 'bar');
    const waiter = await memberToken(r.org, 'waiter');
    const elsewhere = await memberToken(r.org, 'kitchen', [r.org.locations[1]]);
    // A bar ticket through the kitchen route doesn't exist there.
    await move(cook, 'kitchen', r.barTicket, 'ready').expect(404);
    await move(bartender, 'kitchen', r.kitchenTicket, 'ready').expect(403);
    await get(bartender, `/pos/stations/kitchen/tickets?locationId=${r.here}`).expect(403);
    await get(waiter, `/pos/stations/bar/tickets?locationId=${r.here}`).expect(403);
    await move(elsewhere, 'kitchen', r.kitchenTicket, 'ready').expect(404);
    await get(elsewhere, `/pos/stations/kitchen/tickets?locationId=${r.here}`).expect(404);
    await move(bartender, 'bar', r.barTicket, 'ready').expect(201);
  });

  it('lets a waiter serve a ready ticket from the till, and nothing else', async () => {
    const r = await restaurant();
    const waiter = await memberToken(r.org, 'waiter');
    const cook = await memberToken(r.org, 'kitchen');
    const served = `/pos/orders/${r.order.id}/tickets/${r.kitchenTicket}/served`;
    expect((await post(waiter, served).expect(409)).body).toMatchObject({
      code: 'pos.ticket_status_invalid',
    });
    await move(waiter, 'kitchen', r.kitchenTicket, 'ready').expect(403);
    await move(cook, 'kitchen', r.kitchenTicket, 'ready').expect(201);

    // Ready shows on the floor and the order.
    const floor = floorResponseSchema.parse((await get(waiter, '/pos/floor').expect(200)).body);
    expect(floor.data.find((t) => t.id === r.t1)?.order?.readyCount).toBe(1);
    const order = orderSchema.parse((await post(waiter, served).expect(201)).body);
    expect(order.tickets.map((t) => [t.station, t.status])).toEqual([
      ['kitchen', 'served'],
      ['bar', 'new'],
    ]);
    expect(order.readyCount).toBe(0);
    // Served twice is no change; the cook can't serve through the till.
    await post(waiter, served).expect(201);
    await post(cook, served).expect(403);
    // A ticket of another order isn't this order's.
    await post(waiter, `/pos/orders/${uuidv7()}/tickets/${r.kitchenTicket}/served`).expect(404);
  });

  it("never shows or moves another organization's tickets", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const cookB = await memberToken(b.org, 'kitchen');
    await move(cookB, 'kitchen', a.kitchenTicket, 'ready').expect(404);
    await get(cookB, `/pos/stations/kitchen/tickets?locationId=${a.here}`).expect(404);
    const waiterB = await memberToken(b.org, 'waiter');
    await post(waiterB, `/pos/orders/${a.order.id}/tickets/${a.kitchenTicket}/served`).expect(404);
    const cookA = await memberToken(a.org, 'kitchen');
    expect((await board(cookA, 'kitchen', a.here))[0]?.status).toBe('new');
  });

  it('gives Kitchen and Bar their screen only: no orders, menu or tables', async () => {
    const r = await restaurant();
    const cook = await memberToken(r.org, 'kitchen');
    await get(cook, '/pos/floor').expect(403);
    await get(cook, '/catalog/products').expect(403);
    await get(cook, '/pos/tables').expect(403);
  });
});
