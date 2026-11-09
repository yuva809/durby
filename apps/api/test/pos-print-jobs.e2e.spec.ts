import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  claimPrintJobResponseSchema,
  diningTableSchema,
  duePrintJobsResponseSchema,
  printerSchema,
  printJobSchema,
  printJobStatusSchema,
  productCategorySchema,
  productSchema,
  sendTicketResponseSchema,
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

/** ADR 0033 §10–12: tickets and bills queued per printer, claimed by one till, retried only when nothing printed. */
describe('pos print jobs', () => {
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

  async function member(o: SeededOrg, role: 'owner' | 'waiter' | 'staff', locations?: string[]) {
    const userId = await seed.user();
    await seed.member(o.id, userId, o.roles[role], locations ? { locations } : {});
    return seed.token(userId, o.id);
  }

  const get = (token: string, path: string) =>
    request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' });

  const post = (token: string, path: string, body: object = {}, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body);

  const patch = (token: string, path: string, body: object) =>
    withIdempotencyKey(
      request(server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);

  interface Restaurant {
    org: SeededOrg;
    owner: string;
    here: string;
    soup: string;
    beer: string;
    table: string;
  }

  /** A soup (kitchen) and a beer (bar), and a table at the first location. */
  async function restaurant(): Promise<Restaurant> {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const owner = await member(org, 'owner');
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
            taxRate: '19',
          }).expect(201)
        ).body,
      ).id;
    const soup = await product(await category('Food', 'kitchen'), 'Soup');
    const beer = await product(await category('Drinks', 'bar'), 'Beer');
    const table = diningTableSchema.parse(
      (
        await post(owner, '/pos/tables', {
          locationId: org.locations[0],
          name: 'T1',
          seats: 4,
        }).expect(201)
      ).body,
    ).id;
    return { org, owner, here: org.locations[0], soup, beer, table };
  }

  /** A printer, switched on unless `on` is false. */
  async function printer(
    r: Restaurant,
    name: string,
    { stations = [] as string[], bills = false, on = true, locationId = r.here } = {},
  ) {
    const created = printerSchema.parse(
      (
        await post(r.owner, '/pos/printers', {
          locationId,
          name,
          host: '192.168.64.20',
          port: 9100,
          widthDots: 576,
          cutter: true,
          imageMode: 'gsV0',
          printsBills: bills,
          stations,
        }).expect(201)
      ).body,
    );
    if (on) await patch(r.owner, `/pos/printers/${created.id}`, { enabled: true }).expect(200);
    return created.id;
  }

  const send = async (r: Restaurant, lines: object[]) =>
    sendTicketResponseSchema.parse(
      (await post(r.owner, `/pos/tables/${r.table}/tickets`, { lines }).expect(201)).body,
    );

  const jobsOf = (r: Restaurant) =>
    seed.as(r.org.id, (db) =>
      db.posPrintJob.findMany({
        select: { id: true, printerId: true, ticketId: true, kind: true, status: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const claim = async (token: string, locationId: string) =>
    claimPrintJobResponseSchema.parse(
      (await post(token, '/pos/print-jobs/claim', { locationId }).expect(200)).body,
    ).job;

  const answer = (token: string, id: string, body: object) =>
    post(token, `/pos/print-jobs/${id}/result`, body);

  it("queues a send's tickets on every printer that is on and serves the station", async () => {
    const r = await restaurant();
    const kitchen = await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const bar = await printer(r, 'Bar', { stations: ['bar'] });
    const both = await printer(r, 'Both', { stations: ['kitchen', 'bar'] });
    await printer(r, 'New', { stations: ['kitchen'], on: false });
    await printer(r, 'Receipt', { bills: true });
    await printer(r, 'Elsewhere', { stations: ['kitchen'], locationId: r.org.locations[1] });

    const res = await send(r, [
      { productId: r.soup, quantity: 1 },
      { productId: r.beer, quantity: 2 },
    ]);
    const [kitchenTicket, barTicket] = res.ticketIds;
    const jobs = await jobsOf(r);
    const pairs = jobs.map((j) => [j.ticketId, j.printerId]).sort();
    expect(pairs).toEqual(
      [
        [kitchenTicket, kitchen],
        [kitchenTicket, both],
        [barTicket, bar],
        [barTicket, both],
      ].sort(),
    );
    expect(jobs.every((j) => j.kind === 'ticket' && j.status === 'pending')).toBe(true);
    const audit = await seed.as(r.org.id, (db) =>
      db.auditLog.count({ where: { action: 'pos.print_job.queued' } }),
    );
    expect(audit).toBe(4);
  });

  it('queues nothing for a station whose processing is off (straight to the bill)', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    await withIdempotencyKey(
      request(server)
        .put(`/api/v1/settings/pos.kitchenProcessing?locationId=${r.here}`)
        .auth(r.owner, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ value: false })
      .expect(200);
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    expect(await jobsOf(r)).toEqual([]);
  });

  it('hands each job to exactly one of two tills claiming at the same time', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const tills = await Promise.all([
      member(r.org, 'waiter', [r.here]),
      member(r.org, 'waiter', [r.here]),
    ]);
    for (let round = 0; round < 5; round++) {
      await send(r, [{ productId: r.soup, quantity: 1 }]);
      const due = duePrintJobsResponseSchema.parse(
        (await get(tills[0], `/pos/print-jobs/due?locationId=${r.here}`).expect(200)).body,
      );
      expect(due.data).toHaveLength(1);
      const answers = await Promise.all(tills.map((t) => claim(t, r.here)));
      const winners = answers.filter((j) => j !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.id).toBe(due.data[0]!.id);
      await answer(tills[answers.findIndex((j) => j !== null)]!, winners[0]!.id, {
        code: 'print.sent',
      }).expect(200);
    }
  });

  it('retries by itself only when nothing can have printed', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const till = await member(r.org, 'waiter', [r.here]);
    const run = async (body: object) => {
      await send(r, [{ productId: r.soup, quantity: 1 }]);
      const job = await claim(till, r.here);
      return printJobSchema.parse((await answer(till, job!.id, body).expect(200)).body);
    };

    expect(await run({ code: 'print.sent' })).toMatchObject({ status: 'printed', attempts: 1 });
    const unreachable = await run({ code: 'print.printer_unreachable' });
    expect(unreachable).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastCode: 'print.printer_unreachable',
      claimedAt: null,
    });
    // Back in the queue only after the wait.
    expect(Date.parse(unreachable.notBefore) - Date.now()).toBeGreaterThan(3_000);
    expect(await claim(till, r.here)).toBeNull();
    // Lost while sending: may have printed, so a person decides. The app may say nothing was sent.
    expect(await run({ code: 'print.printer_disconnected' })).toMatchObject({
      status: 'needs_check',
    });
    expect(await run({ code: 'print.printer_timeout', nothingPrinted: true })).toMatchObject({
      status: 'pending',
    });
    expect(await run({ code: 'print.payload_invalid' })).toMatchObject({ status: 'failed' });
  });

  it('takes the answer only from the till that holds the job, once', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const till = await member(r.org, 'waiter', [r.here]);
    const other = await member(r.org, 'waiter', [r.here]);
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    const job = await claim(till, r.here);
    const wrong = await answer(other, job!.id, { code: 'print.sent' }).expect(409);
    expect(wrong.body).toMatchObject({ code: 'pos.print_job_not_claimed' });
    await answer(till, job!.id, { code: 'print.sent' }).expect(200);
    await answer(till, job!.id, { code: 'print.sent' }).expect(409);
    await answer(till, job!.id, { code: 'print.made_up' }).expect(400);
  });

  it('reprints a job that may have printed or was never answered, never a printed one', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const till = await member(r.org, 'waiter', [r.here]);
    await send(r, [{ productId: r.soup, quantity: 2 }]);
    const lost = await claim(till, r.here);
    await answer(till, lost!.id, { code: 'print.printer_disconnected' }).expect(200);
    const again = printJobSchema.parse(
      (await post(till, `/pos/print-jobs/${lost!.id}/reprint`).expect(200)).body,
    );
    expect(again).toMatchObject({ status: 'pending', claimedAt: null, completedAt: null });

    const printed = await claim(till, r.here);
    await answer(till, printed!.id, { code: 'print.sent' }).expect(200);
    const refused = await post(till, `/pos/print-jobs/${printed!.id}/reprint`).expect(409);
    expect(refused.body).toMatchObject({ code: 'pos.print_job_not_reprintable' });

    // Claimed and silent for over a minute: shown as stale, and reprintable.
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    const silent = await claim(till, r.here);
    await post(till, `/pos/print-jobs/${silent!.id}/reprint`).expect(409);
    await seed.as(r.org.id, (db) =>
      db.posPrintJob.update({
        where: { id: silent!.id },
        data: {
          claimedAt: new Date(Date.now() - 2 * 60_000),
          createdAt: new Date(Date.now() - 3 * 60_000),
        },
      }),
    );
    await post(till, `/pos/print-jobs/${silent!.id}/reprint`).expect(200);
  });

  it('tells the warnings what waits, what retries and what needs a person', async () => {
    const r = await restaurant();
    const kitchen = await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const till = await member(r.org, 'waiter', [r.here]);
    const status = async () =>
      printJobStatusSchema.parse(
        (await get(till, `/pos/print-jobs/status?locationId=${r.here}`).expect(200)).body,
      );
    expect(await status()).toMatchObject({ waiting: { count: 0 }, retrying: [], attention: [] });

    await send(r, [{ productId: r.soup, quantity: 1 }]);
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    const first = await claim(till, r.here);
    await answer(till, first!.id, { code: 'print.paper_out' }).expect(200);
    const second = await claim(till, r.here);
    await answer(till, second!.id, { code: 'print.printer_disconnected' }).expect(200);
    await seed.as(r.org.id, (db) =>
      db.posPrintJob.updateMany({ data: { createdAt: new Date(Date.now() - 30_000) } }),
    );
    await get(till, `/pos/print-jobs/due?locationId=${r.here}`).expect(200);

    const now = await status();
    expect(now.waiting.count).toBe(1);
    expect(now.retrying).toEqual([{ printerId: kitchen, lastCode: 'print.paper_out', count: 1 }]);
    expect(now.attention.map((j) => [j.id, j.status])).toEqual([[second!.id, 'needs_check']]);
    // The poll just now: a till is printing here.
    expect(Date.now() - Date.parse(now.tillSeenAt!)).toBeLessThan(10_000);
  });

  it('queues a bill from a device without the app for a receipt printer of the location', async () => {
    const r = await restaurant();
    const receipt = await printer(r, 'Till', { bills: true });
    const kitchen = await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const off = await printer(r, 'Till 2', { bills: true, on: false });
    const res = await send(r, [{ productId: r.soup, quantity: 1 }]);
    const orderId = res.order.id;
    const phone = await member(r.org, 'waiter', [r.here]);
    const job = printJobSchema.parse(
      (await post(phone, '/pos/print-jobs/bill', { orderId, printerId: receipt }).expect(201)).body,
    );
    expect(job).toMatchObject({ kind: 'bill', orderId, ticketId: null, printerId: receipt });
    await post(phone, '/pos/print-jobs/bill', { orderId, printerId: kitchen }).expect(404);
    await post(phone, '/pos/print-jobs/bill', { orderId, printerId: off }).expect(404);
    const staff = await member(r.org, 'staff');
    await post(staff, '/pos/print-jobs/bill', { orderId, printerId: receipt }).expect(403);
  });

  it('keeps a till to its own location and never shows another organization a job', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    const elsewhere = await member(r.org, 'waiter', [r.org.locations[1]]);
    await get(elsewhere, `/pos/print-jobs/due?locationId=${r.here}`).expect(404);
    await post(elsewhere, '/pos/print-jobs/claim', { locationId: r.here }).expect(404);

    const b = await restaurant();
    const [job] = await jobsOf(r);
    // The poll stays one query (no location lookup): a foreign location simply has no jobs for this
    // organization (RLS), and nothing can be claimed there.
    expect(
      (await get(b.owner, `/pos/print-jobs/due?locationId=${r.here}`).expect(200)).body,
    ).toEqual({
      data: [],
    });
    expect(await claim(b.owner, r.here)).toBeNull();
    await answer(b.owner, job!.id, { code: 'print.sent' }).expect(404);
    await post(b.owner, `/pos/print-jobs/${job!.id}/reprint`).expect(404);
    expect(await seed.as(b.org.id, (db) => db.posPrintJob.count())).toBe(0);
  });

  it('replays a claim with the same Idempotency-Key instead of taking a second job', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const till = await member(r.org, 'waiter', [r.here]);
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    const key = uuidv7();
    const first = (
      await post(till, '/pos/print-jobs/claim', { locationId: r.here }, key).expect(200)
    ).body as { job: { id: string } };
    const again = (
      await post(till, '/pos/print-jobs/claim', { locationId: r.here }, key).expect(200)
    ).body as { job: { id: string } };
    expect(again.job.id).toBe(first.job.id);
    const statuses = (await jobsOf(r)).map((j) => j.status).sort();
    expect(statuses).toEqual(['claimed', 'pending']);
  });

  it('never prints anything older than its maximum age: a printer offline 11 minutes, then back', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    const till = await member(r.org, 'waiter', [r.here]);
    const ticketJob = async () => {
      await send(r, [{ productId: r.soup, quantity: 1 }]);
      return (await jobsOf(r)).at(-1)!.id;
    };
    const age = (id: string, extra: object = {}) =>
      seed.as(r.org.id, (db) =>
        db.posPrintJob.update({
          where: { id },
          data: {
            createdAt: new Date(Date.now() - 11 * 60_000),
            expiresAt: new Date(Date.now() - 60_000),
            notBefore: new Date(Date.now() - 1_000),
            ...extra,
          },
        }),
      );

    // Retried while the printer was away, never claimed, and claimed just before it went away.
    const retried = await ticketJob();
    expect((await claim(till, r.here))!.id).toBe(retried);
    await answer(till, retried, { code: 'print.printer_unreachable' }).expect(200);
    await age(retried);
    const waiting = await ticketJob();
    await age(waiting);
    const held = await ticketJob();
    expect((await claim(till, r.here))!.id).toBe(held);
    await age(held, { claimedAt: new Date(Date.now() - 30_000) });
    // Its retry would come after the maximum age: a person decides.
    const late = printJobSchema.parse(
      (await answer(till, held, { code: 'print.printer_unreachable' }).expect(200)).body,
    );
    expect(late).toMatchObject({ status: 'needs_check', lastCode: 'print.expired', expired: true });

    // The printer is back: nothing old is handed out.
    expect(
      duePrintJobsResponseSchema.parse(
        (await get(till, `/pos/print-jobs/due?locationId=${r.here}`).expect(200)).body,
      ).data,
    ).toEqual([]);
    expect(await claim(till, r.here)).toBeNull();
    const status = printJobStatusSchema.parse(
      (await get(till, `/pos/print-jobs/status?locationId=${r.here}`).expect(200)).body,
    );
    expect(status.waiting.count).toBe(0);
    expect(status.retrying).toEqual([]);
    expect(status.attention.map((j) => [j.id, j.status, j.lastCode, j.expired]).sort()).toEqual(
      [
        [retried, 'needs_check', 'print.expired', true],
        [waiting, 'needs_check', 'print.expired', true],
        [held, 'needs_check', 'print.expired', true],
      ].sort(),
    );

    // A new ticket prints at once; an old one only when someone reprints it.
    const fresh = await ticketJob();
    expect((await claim(till, r.here))!.id).toBe(fresh);
    await answer(till, fresh, { code: 'print.sent' }).expect(200);
    const again = printJobSchema.parse(
      (await post(till, `/pos/print-jobs/${waiting}/reprint`).expect(200)).body,
    );
    expect(again).toMatchObject({ status: 'pending', expired: false });
    expect(Date.parse(again.expiresAt)).toBeGreaterThan(Date.now());
    expect((await claim(till, r.here))!.id).toBe(waiting);
  });

  it('fixes the maximum age when a job is queued, from the location setting', async () => {
    const r = await restaurant();
    await printer(r, 'Kitchen', { stations: ['kitchen'] });
    await withIdempotencyKey(
      request(server)
        .put(`/api/v1/settings/pos.printJobMaxAgeSeconds?locationId=${r.here}`)
        .auth(r.owner, { type: 'bearer' }),
      uuidv7(),
    )
      .send({ value: 120 })
      .expect(200);
    await send(r, [{ productId: r.soup, quantity: 1 }]);
    const [job] = await seed.as(r.org.id, (db) =>
      db.posPrintJob.findMany({ select: { createdAt: true, expiresAt: true } }),
    );
    // Queued at the database's time, the window from the api's: equal up to the clocks' drift.
    expect(Math.abs(job!.expiresAt.getTime() - job!.createdAt.getTime() - 120_000)).toBeLessThan(
      2_000,
    );
  });

  it('keeps one open bill per order and printer: two taps, one job, one print', async () => {
    const r = await restaurant();
    const receipt = await printer(r, 'Till', { bills: true });
    const till = await member(r.org, 'waiter', [r.here]);
    const phone = await member(r.org, 'waiter', [r.here]);
    const { order } = await send(r, [{ productId: r.soup, quantity: 1 }]);
    const tap = async () =>
      printJobSchema.parse(
        (
          await post(phone, '/pos/print-jobs/bill', {
            orderId: order.id,
            printerId: receipt,
          }).expect(201)
        ).body,
      );
    const first = await tap();
    const second = await tap();
    expect(second.id).toBe(first.id);
    // At the same moment too.
    const both = await Promise.all([tap(), tap()]);
    expect(both.map((j) => j.id)).toEqual([first.id, first.id]);

    const job = await claim(till, r.here);
    expect(job!.id).toBe(first.id);
    // A tap while the till prints it: still the same job.
    expect((await tap()).id).toBe(first.id);
    await answer(till, first.id, { code: 'print.sent' }).expect(200);
    expect(await claim(till, r.here)).toBeNull();
    const bills = await seed.as(r.org.id, (db) =>
      db.posPrintJob.findMany({ where: { kind: 'bill' }, select: { status: true } }),
    );
    expect(bills).toEqual([{ status: 'printed' }]);

    // Printed: the next tap is a new bill.
    expect((await tap()).id).not.toBe(first.id);
  });
});
