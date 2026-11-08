import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  claimPrinterCommandResponseSchema,
  printerCommandListResponseSchema,
  printerCommandSchema,
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

/** ADR 0032 §15: Owner/Admin ask a location's till to find printers or print a test page. */
describe('pos printer commands', () => {
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

  const post = (token: string, path: string, body: object, key = uuidv7()) =>
    withIdempotencyKey(
      request(server).post(`/api/v1/pos/printer-commands${path}`).auth(token, { type: 'bearer' }),
      key,
    ).send(body);

  const get = (token: string, path: string, locationId: string) =>
    request(server)
      .get(`/api/v1/pos/printer-commands${path}?locationId=${locationId}`)
      .auth(token, { type: 'bearer' });

  /** A printer per location for test prints (ADR 0033), added once. */
  const printers = new Map<string, string>();
  const printerAt = async (token: string, locationId: string) => {
    const known = printers.get(locationId);
    if (known) return known;
    const created = await withIdempotencyKey(
      request(server).post('/api/v1/pos/printers').auth(token, { type: 'bearer' }),
      uuidv7(),
    )
      .send({
        locationId,
        name: 'Bar',
        host: '192.168.64.20',
        port: 9100,
        widthDots: 576,
        cutter: true,
        imageMode: 'gsV0',
        printsBills: true,
        stations: [],
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    printers.set(locationId, id);
    return id;
  };

  const ask = async (token: string, locationId: string, kind: 'find_printers' | 'test_print') =>
    printerCommandSchema.parse(
      (
        await post(token, '', {
          locationId,
          kind,
          ...(kind === 'test_print' ? { printerId: await printerAt(token, locationId) } : {}),
        }).expect(201)
      ).body,
    );

  const claim = (token: string, locationId: string) => post(token, '/claim', { locationId });

  const found = {
    subnet: '192.168.64.0/24',
    printers: [{ host: '192.168.64.20', port: 9100, status: 'online' }],
  };

  it('runs a command from request to result, every step audited', async () => {
    const { org: o, owner } = await org();
    const till = await member(o, 'waiter', [o.locations[0]]);
    const command = await ask(owner, o.locations[0], 'find_printers');
    expect(command).toMatchObject({ kind: 'find_printers', status: 'pending', expired: false });
    expect(Date.parse(command.expiresAt) - Date.parse(command.createdAt)).toBe(5 * 60 * 1000);

    const pending = printerCommandListResponseSchema.parse(
      (await get(till, '/pending', o.locations[0]).expect(200)).body,
    );
    expect(pending.data.map((c) => c.id)).toEqual([command.id]);

    const claimed = claimPrinterCommandResponseSchema.parse(
      (await claim(till, o.locations[0]).expect(200)).body,
    );
    expect(claimed.command).toMatchObject({ id: command.id, status: 'claimed' });
    // Taken: nothing is open any more.
    expect((await get(till, '/pending', o.locations[0]).expect(200)).body).toEqual({ data: [] });
    expect((await claim(till, o.locations[0]).expect(200)).body).toEqual({ command: null });

    const done = printerCommandSchema.parse(
      (await post(till, `/${command.id}/result`, { result: found }).expect(200)).body,
    );
    expect(done).toMatchObject({ status: 'done', result: found });
    expect(done.completedAt).not.toBeNull();

    const list = printerCommandListResponseSchema.parse(
      (await get(owner, '', o.locations[0]).expect(200)).body,
    );
    expect(list.data[0]).toMatchObject({ id: command.id, status: 'done', result: found });

    const audit = await seed.as(o.id, (db) =>
      db.auditLog.findMany({
        where: { entityId: command.id },
        orderBy: { createdAt: 'asc' },
        select: { action: true, entityType: true, after: true },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual([
      'pos.printer_command.requested',
      'pos.printer_command.claimed',
      'pos.printer_command.completed',
    ]);
    expect(audit[2]).toMatchObject({
      entityType: 'printer_command',
      after: { status: 'done', resultCode: 'found', printerCount: 1 },
    });
  });

  it('gives a command to exactly one of two tills claiming at the same time', async () => {
    const { org: o, owner } = await org();
    const tills = await Promise.all([
      member(o, 'waiter', [o.locations[0]]),
      member(o, 'waiter', [o.locations[0]]),
    ]);
    for (let round = 0; round < 5; round++) {
      const command = await ask(owner, o.locations[0], 'test_print');
      const answers = await Promise.all(
        tills.map(async (t) =>
          claimPrinterCommandResponseSchema.parse(
            (await claim(t, o.locations[0]).expect(200)).body,
          ),
        ),
      );
      const winners = answers.filter((a) => a.command !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.command!.id).toBe(command.id);
    }
  });

  it('sends a test print to one printer of the location, and carries it to the till (ADR 0033)', async () => {
    const { org: o, owner } = await org();
    const till = await member(o, 'waiter', [o.locations[0]]);
    const err = await post(owner, '', { locationId: o.locations[0], kind: 'test_print' }).expect(
      400,
    );
    expect(err.body).toMatchObject({ code: 'pos.printer_required' });
    const elsewhere = await printerAt(owner, o.locations[1]);
    await post(owner, '', {
      locationId: o.locations[0],
      kind: 'test_print',
      printerId: elsewhere,
    }).expect(404);

    const find = await ask(owner, o.locations[0], 'find_printers');
    expect(find.printerId).toBeNull();
    const test = await ask(owner, o.locations[0], 'test_print');
    expect(test.printerId).toBe(printers.get(o.locations[0]));
    const first = claimPrinterCommandResponseSchema.parse(
      (await claim(till, o.locations[0]).expect(200)).body,
    );
    const second = claimPrinterCommandResponseSchema.parse(
      (await claim(till, o.locations[0]).expect(200)).body,
    );
    expect([first.command?.printerId, second.command?.printerId]).toEqual([
      null,
      printers.get(o.locations[0]),
    ]);
  });

  it('marks a test print failed with its code, and refuses a printer list for it', async () => {
    const { org: o, owner } = await org();
    const till = await member(o, 'waiter', [o.locations[0]]);
    const command = await ask(owner, o.locations[0], 'test_print');
    await claim(till, o.locations[0]).expect(200);
    await post(till, `/${command.id}/result`, { result: found }).expect(400);
    const failed = printerCommandSchema.parse(
      (
        await post(till, `/${command.id}/result`, {
          result: { code: 'print.printer_unreachable' },
        }).expect(200)
      ).body,
    );
    expect(failed).toMatchObject({
      status: 'failed',
      result: { code: 'print.printer_unreachable' },
    });
    // Finished: a second result is refused.
    const again = await post(till, `/${command.id}/result`, { result: { code: 'print.sent' } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'pos.printer_command_not_claimed' });
  });

  it('never hands out or finishes a command after its 5 minutes', async () => {
    const { org: o, owner } = await org();
    const till = await member(o, 'waiter', [o.locations[0]]);
    const old = await ask(owner, o.locations[0], 'find_printers');
    // One instant for every time below: the database allows at most exactly 5 minutes between them.
    const now = Date.now();
    const past = (minutes: number) => new Date(now - minutes * 60 * 1000);
    await seed.as(o.id, (db) =>
      db.posPrinterCommand.update({
        where: { id: old.id },
        data: { createdAt: past(6), expiresAt: past(1) },
      }),
    );
    expect((await get(till, '/pending', o.locations[0]).expect(200)).body).toEqual({ data: [] });
    expect((await claim(till, o.locations[0]).expect(200)).body).toEqual({ command: null });
    const listed = printerCommandListResponseSchema.parse(
      (await get(owner, '', o.locations[0]).expect(200)).body,
    );
    expect(listed.data[0]).toMatchObject({ id: old.id, status: 'pending', expired: true });

    // Claimed in time, answered too late.
    const late = await ask(owner, o.locations[0], 'test_print');
    await claim(till, o.locations[0]).expect(200);
    await seed.as(o.id, (db) =>
      db.posPrinterCommand.update({
        where: { id: late.id },
        data: { createdAt: past(6), expiresAt: past(1), claimedAt: past(5) },
      }),
    );
    const answer = await post(till, `/${late.id}/result`, { result: { code: 'print.sent' } });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: 'pos.printer_command_expired' });
  });

  it('is for Owner and Admin to request, and for the location’s tills to run', async () => {
    const { org: o, owner } = await org();
    const admin = await member(o, 'admin');
    const waiter = await member(o, 'waiter', [o.locations[0]]);
    const elsewhere = await member(o, 'waiter', [o.locations[1]]);
    const staff = await member(o, 'staff');

    await ask(admin, o.locations[0], 'find_printers');
    await post(waiter, '', { locationId: o.locations[0], kind: 'test_print' }).expect(403);
    await post(owner, '', { locationId: uuidv7(), kind: 'test_print' }).expect(404);
    await post(owner, '', { locationId: o.locations[0], kind: 'reboot' }).expect(400);

    // A till of another location never sees or takes this location's commands.
    expect((await get(elsewhere, '/pending', o.locations[0]).expect(404)).body).toMatchObject({
      code: 'pos.location_not_found',
    });
    await claim(elsewhere, o.locations[0]).expect(404);
    await claim(staff, o.locations[0]).expect(403);

    // Only the till that claimed a command answers it.
    const command = await ask(owner, o.locations[0], 'test_print');
    await claim(waiter, o.locations[0]).expect(200);
    const other = await member(o, 'waiter', [o.locations[0]]);
    const answer = await post(other, `/${command.id}/result`, { result: { code: 'print.sent' } });
    expect(answer.body).toMatchObject({ code: 'pos.printer_command_not_claimed' });
    await post(elsewhere, `/${command.id}/result`, { result: { code: 'print.sent' } }).expect(404);
  });

  it('refuses results with anything but addresses and codes', async () => {
    const { org: o, owner } = await org();
    const till = await member(o, 'waiter', [o.locations[0]]);
    const command = await ask(owner, o.locations[0], 'find_printers');
    await claim(till, o.locations[0]).expect(200);
    const bad = [
      { subnet: '192.168.64.0/24', printers: [{ host: '8.8.8.8', port: 9100, status: 'online' }] },
      { subnet: 'anywhere', printers: [] },
      { code: 'print.sent', note: 'hello' },
      { code: 'made_up' },
    ];
    for (const result of bad) {
      await post(till, `/${command.id}/result`, { result }).expect(400);
    }
  });

  it('replays a request with the same Idempotency-Key instead of asking twice', async () => {
    const { org: o, owner } = await org();
    const key = uuidv7();
    const body = { locationId: o.locations[0], kind: 'find_printers' };
    const first = (await post(owner, '', body, key).expect(201)).body as { id: string };
    const second = (await post(owner, '', body, key).expect(201)).body as { id: string };
    expect(second.id).toBe(first.id);
    const list = printerCommandListResponseSchema.parse(
      (await get(owner, '', o.locations[0]).expect(200)).body,
    );
    expect(list.data).toHaveLength(1);
  });

  it("never shows or runs another organization's commands", async () => {
    const a = await org();
    const b = await org();
    const command = await ask(a.owner, a.org.locations[0], 'find_printers');
    await get(b.owner, '', a.org.locations[0]).expect(404);
    await get(b.owner, '/pending', a.org.locations[0]).expect(404);
    await claim(b.owner, a.org.locations[0]).expect(404);
    await post(b.owner, `/${command.id}/result`, { result: { code: 'print.sent' } }).expect(404);
    const rows = await seed.as(b.org.id, (db) => db.posPrinterCommand.count());
    expect(rows).toBe(0);
  });
});
