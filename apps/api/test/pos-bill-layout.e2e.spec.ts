import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  billLayoutSchema,
  DEFAULT_BILL_FOOTER,
  DEFAULT_BILL_TEXT,
  DEFAULT_TICKET_TEXT,
  DEFAULT_BILL_HEADER,
  DEFAULT_POS_PRINTERS,
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

/** docs/modules/pos.md → Bill layout (ADR 0025): the bill's header and footer at a location. */
describe('pos bill layout', () => {
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

  const LOGO =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';

  async function org(): Promise<{ org: SeededOrg; owner: string }> {
    const o = await seed.org();
    await entitlements.setPlan(o.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(o.id, userId, o.roles.owner);
    return { org: o, owner: await seed.token(userId, o.id) };
  }

  async function member(o: SeededOrg, role: 'waiter' | 'staff', locations?: string[]) {
    const userId = await seed.user();
    await seed.member(o.id, userId, o.roles[role], locations ? { locations } : {});
    return seed.token(userId, o.id);
  }

  const layout = (token: string, locationId: string) =>
    request(server)
      .get(`/api/v1/pos/bill-layout?locationId=${locationId}`)
      .auth(token, { type: 'bearer' });

  const put = (token: string, key: string, value: unknown, locationId?: string) =>
    withIdempotencyKey(
      request(server)
        .put(`/api/v1/settings/${key}${locationId ? `?locationId=${locationId}` : ''}`)
        .auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send({ value });

  it('starts empty: no header fields, no footer lines', async () => {
    const { org: o, owner } = await org();
    const body = billLayoutSchema.parse((await layout(owner, o.locations[0]).expect(200)).body);
    expect(body).toEqual({
      header: DEFAULT_BILL_HEADER,
      footer: DEFAULT_BILL_FOOTER,
      text: DEFAULT_BILL_TEXT,
      ticketText: DEFAULT_TICKET_TEXT,
      printers: DEFAULT_POS_PRINTERS,
      printerList: [],
    });
  });

  // Text sizes (docs/modules/pos.md → Text size): set per location like the header, refused when unknown.
  it("returns the text sizes, a location's own where it has them", async () => {
    const { org: o, owner } = await org();
    const text = { size: 'large', header: null, items: 'xlarge', total: null, footer: 'small' };
    await put(owner, 'pos.billText', text).expect(200);
    await put(owner, 'pos.ticketText', { size: 'xlarge', items: null }, o.locations[0]).expect(200);
    await put(owner, 'pos.billText', { ...text, size: 'huge' }).expect(422);
    const body = billLayoutSchema.parse((await layout(owner, o.locations[0]).expect(200)).body);
    expect(body.text).toEqual(text);
    expect(body.ticketText).toEqual({ size: 'xlarge', items: null });
  });

  it("returns the organization's values, and a location's own where it has them", async () => {
    const { org: o, owner } = await org();
    const header = {
      logo: LOGO,
      name: 'Bay Leaf',
      phone: '+49 30 1234567',
      email: 'hello@bayleaf.example',
      website: 'www.bayleaf.example',
    };
    await put(owner, 'pos.billHeader', header).expect(200);
    await put(owner, 'pos.billFooter', {
      lines: ['Thank you for visiting!', 'Vielen Dank für Ihren Besuch!'],
    }).expect(200);
    await put(
      owner,
      'pos.billHeader',
      { ...header, phone: '+49 40 7654321' },
      o.locations[1],
    ).expect(200);

    const first = billLayoutSchema.parse((await layout(owner, o.locations[0]).expect(200)).body);
    expect(first.header).toEqual(header);
    expect(first.footer.lines).toEqual([
      'Thank you for visiting!',
      'Vielen Dank für Ihren Besuch!',
    ]);
    const second = billLayoutSchema.parse((await layout(owner, o.locations[1]).expect(200)).body);
    expect(second.header.phone).toBe('+49 40 7654321');
    expect(second.footer).toEqual(first.footer);
  });

  it("carries the location's printer to those who print there (ADR 0032)", async () => {
    const { org: o, owner } = await org();
    const bill = {
      host: '192.168.64.20',
      port: 9100,
      widthDots: 384,
      cutter: true,
      imageMode: 'gsV0',
    };
    await put(owner, 'pos.printers', { bill }, o.locations[0]).expect(200);
    const waiter = await member(o, 'waiter', [o.locations[0]]);
    const here = billLayoutSchema.parse((await layout(waiter, o.locations[0]).expect(200)).body);
    expect(here.printers.bill).toEqual(bill);
    const there = billLayoutSchema.parse((await layout(owner, o.locations[1]).expect(200)).body);
    expect(there.printers.bill).toBeNull();
  });

  it('still gives the bill printer when a later release saved more (rollback, ADR 0033)', async () => {
    const { org: o, owner } = await org();
    const bill = {
      host: '192.168.64.21',
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
    };
    await put(owner, 'pos.printers', { bill }, o.locations[0]).expect(200);
    // As a later release might store it: a new key and a new field, which this release's writes refuse.
    await seed.as(o.id, (db) =>
      db.settingValue.updateMany({
        where: { key: 'pos.printers', locationId: o.locations[0] },
        data: { value: { bill: { ...bill, paperSaver: true }, kitchen: bill } },
      }),
    );
    await put(owner, 'pos.printers', { bill, kitchen: bill }, o.locations[1]).expect(422);
    const here = billLayoutSchema.parse((await layout(owner, o.locations[0]).expect(200)).body);
    expect(here.printers).toEqual({ bill });
  });

  it('refuses printer addresses outside the private network and other ports', async () => {
    const { owner } = await org();
    const bill = { host: '8.8.8.8', port: 9100, widthDots: 384, cutter: true, imageMode: 'gsV0' };
    await put(owner, 'pos.printers', { bill }).expect(422);
    await put(owner, 'pos.printers', { bill: { ...bill, host: '192.168.1.5', port: 80 } }).expect(
      422,
    );
    await put(owner, 'pos.printers', { bill: { ...bill, host: 'printer.local' } }).expect(422);
  });

  it('refuses invalid values through the settings api', async () => {
    const { owner } = await org();
    await put(owner, 'pos.billHeader', {
      ...DEFAULT_BILL_HEADER,
      logo: 'https://x.test/l.png',
    }).expect(422);
    await put(owner, 'pos.billFooter', { lines: ['a', 'b', 'c', 'd', 'e'] }).expect(422);
  });

  it('is for those who print bills there; others and unknown locations get 403/404', async () => {
    const { org: o } = await org();
    const waiter = await member(o, 'waiter', [o.locations[0]]);
    await layout(waiter, o.locations[0]).expect(200);
    // Location-limited: the other location doesn't exist for them.
    const other = await layout(waiter, o.locations[1]).expect(404);
    expect(other.body).toMatchObject({ code: 'pos.location_not_found' });
    const staff = await member(o, 'staff');
    await layout(staff, o.locations[0]).expect(403);
    await layout(waiter, uuidv7()).expect(404);
    await request(server)
      .get('/api/v1/pos/bill-layout?locationId=nope')
      .auth(waiter, { type: 'bearer' })
      .expect(400);
  });

  it("never returns another organization's bill", async () => {
    const a = await org();
    const b = await org();
    await put(a.owner, 'pos.billHeader', { ...DEFAULT_BILL_HEADER, name: 'Secret Kitchen' }).expect(
      200,
    );
    const res = await layout(b.owner, a.org.locations[0]).expect(404);
    expect(JSON.stringify(res.body)).not.toContain('Secret Kitchen');
    const own = billLayoutSchema.parse(
      (await layout(b.owner, b.org.locations[0]).expect(200)).body,
    );
    expect(own.header.name).toBeNull();
  });
});
