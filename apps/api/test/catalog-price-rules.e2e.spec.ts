import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  diningTableSchema,
  type PlanKey,
  priceRuleListResponseSchema,
  priceRuleSchema,
  pricesResponseSchema,
  productCategorySchema,
  productSchema,
  publicMenuSchema,
  sendTicketResponseSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Clock } from '../src/platform/auth';
import { AccessTokenService } from '../src/platform/auth/access-token.service';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { FakeClock } from './support/fake-clock';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/catalog.md → Price rules (ADR 0030). The clock is Friday 2026-11-06; locations are on
 * Europe/Berlin (UTC+1 in November) unless a test moves one.
 */
describe('catalog price rules', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  let tokens: AccessTokenService;
  const clock = new FakeClock();
  /** Friday 2026-11-06 at `time` in Berlin. */
  /** `time` on `date` in Berlin (UTC+1 in November). */
  const berlin = (time: string, date = '2026-11-06') =>
    new Date(new Date(`${date}T${time}:00Z`).getTime() - 60 * 60_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
    tokens = app.get(AccessTokenService);
  });

  beforeEach(() => clock.set(berlin('12:00')));

  afterAll(async () => {
    await app.close();
  });

  /** A member; requests sign a fresh token at the fake clock's time (it moves within tests). */
  type Member = { userId: string; orgId: string };
  async function memberToken(
    org: SeededOrg,
    role: SystemRole,
    locations?: string[],
  ): Promise<Member> {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role], locations ? { locations } : {});
    return { userId, orgId: org.id };
  }

  const bearer = (m: Member) =>
    tokens.sign({ userId: m.userId, organizationId: m.orgId, sessionId: uuidv7() }, clock.now());

  /** A request whose token is signed when it is sent: `get(member, path).expect(200)`. */
  const call = (m: Member, build: (token: string) => request.Test) => ({
    expect: async (status: number) => build(await bearer(m)).expect(status),
  });
  const get = (m: Member, path: string) =>
    call(m, (token) => request(server).get(`/api/v1${path}`).auth(token, { type: 'bearer' }));
  const write = (
    m: Member,
    method: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: unknown,
    key = uuidv7(),
  ) =>
    call(m, (token) =>
      withIdempotencyKey(
        request(server)[method](`/api/v1${path}`).auth(token, { type: 'bearer' }),
        key,
      ).send(body ?? {}),
    );

  /** Drinks (Cola 3.80, Beer 5.00) and Food (Soup 6.90), a table at each of two locations. */
  async function restaurant(plan: PlanKey = 'full') {
    const org = await seed.org();
    await entitlements.setPlan(org.id, plan, 'cli.entitlements');
    const owner = await memberToken(org, 'owner');
    const category = async (name: string) =>
      productCategorySchema.parse(
        (await write(owner, 'post', '/catalog/categories', { name }).expect(201)).body,
      ).id;
    const drinks = await category('Drinks');
    const food = await category('Food');
    const product = async (categoryId: string, name: string, price: string) =>
      productSchema.parse(
        (
          await write(owner, 'post', '/catalog/products', {
            categoryId,
            name,
            price,
            taxRate: '19',
          }).expect(201)
        ).body,
      ).id;
    const cola = await product(drinks, 'Cola', '3.80');
    const beer = await product(drinks, 'Beer', '5.00');
    const soup = await product(food, 'Soup', '6.90');
    const table = async (locationId: string) =>
      diningTableSchema.parse(
        (
          await write(owner, 'post', '/pos/tables', { locationId, name: 'T1', seats: 4 }).expect(
            201,
          )
        ).body,
      );
    const [main, harbour] = org.locations;
    return {
      org,
      owner,
      drinks,
      food,
      cola,
      beer,
      soup,
      main,
      harbour,
      table: await table(main),
      harbourTable: await table(harbour),
    };
  }

  const rule = async (token: Member, body: object) =>
    priceRuleSchema.parse(
      (
        await write(token, 'post', '/catalog/price-rules', {
          name: 'Rule',
          kind: 'fixed',
          ...body,
        }).expect(201)
      ).body,
    );

  const prices = async (token: Member, locationId: string, query = '') =>
    Object.fromEntries(
      pricesResponseSchema
        .parse(
          (await get(token, `/catalog/prices?locationId=${locationId}${query}`).expect(200)).body,
        )
        .data.map((p) => [p.productId, p.price]),
    );

  type Restaurant = Awaited<ReturnType<typeof restaurant>>;
  /** Happy hour: Drinks −20 % Mon–Fri 17:00–19:00 everywhere; Cola 4.00 at the main location. */
  async function withRules(r: Restaurant) {
    const happy = await rule(r.owner, {
      name: 'Happy hour',
      categoryId: r.drinks,
      kind: 'percent_off',
      value: '20',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startsAt: '17:00',
      endsAt: '19:00',
    });
    const mainCola = await rule(r.owner, {
      name: 'Main street',
      productId: r.cola,
      locationId: r.main,
      value: '4.00',
    });
    return { happy, mainCola };
  }

  it('creates, lists, changes and deletes rules, each audited', async () => {
    const r = await restaurant();
    const { happy } = await withRules(r);
    expect(happy).toMatchObject({
      name: 'Happy hour',
      locationId: null,
      productId: null,
      categoryId: r.drinks,
      kind: 'percent_off',
      value: '20.00',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startsAt: '17:00',
      endsAt: '19:00',
      validFrom: null,
      validUntil: null,
      active: true,
    });
    const list = priceRuleListResponseSchema.parse(
      (await get(r.owner, '/catalog/price-rules').expect(200)).body,
    );
    expect(list.data.map((x) => x.name)).toEqual(['Happy hour', 'Main street']);

    const changed = await write(r.owner, 'patch', `/catalog/price-rules/${happy.id}`, {
      days: ['fri', 'thu'],
      validUntil: '2026-12-31',
    }).expect(200);
    expect(priceRuleSchema.parse(changed.body)).toMatchObject({
      days: ['thu', 'fri'],
      validUntil: '2026-12-31',
    });
    // The same values again: no change, no audit row.
    await write(r.owner, 'patch', `/catalog/price-rules/${happy.id}`, { value: '20' }).expect(200);
    await write(r.owner, 'delete', `/catalog/price-rules/${happy.id}`).expect(204);
    await write(r.owner, 'delete', `/catalog/price-rules/${happy.id}`).expect(404);

    const audit = await seed.as(r.org.id, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'price_rule' },
        select: { action: true, after: true },
        orderBy: { id: 'asc' },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual([
      'catalog.price_rule.created',
      'catalog.price_rule.created',
      'catalog.price_rule.updated',
      'catalog.price_rule.deleted',
    ]);
    expect(audit[0]?.after).toMatchObject({ days: 'mon,tue,wed,thu,fri', value: '20.00' });
  });

  it('refuses invalid rules and names the problems', async () => {
    const r = await restaurant();
    const invalid = async (body: object, problems: string[]) => {
      const res = await write(r.owner, 'post', '/catalog/price-rules', {
        name: 'X',
        kind: 'fixed',
        ...body,
      }).expect(400);
      expect(res.body).toMatchObject({ code: 'catalog.price_rule_invalid', details: { problems } });
    };
    await invalid({ value: '1.00' }, ['target']);
    await invalid({ productId: r.cola, kind: 'percent_off', value: '10' }, ['percent_on_product']);
    await invalid({ categoryId: r.drinks, kind: 'percent_off', value: '150' }, ['value']);
    await invalid({ productId: r.cola, value: '1.00', startsAt: '17:00' }, ['hours']);
    await invalid(
      { productId: r.cola, value: '1.00', validFrom: '2026-12-01', validUntil: '2026-11-01' },
      ['dates'],
    );
    // A change is checked on the whole rule.
    const ok = await rule(r.owner, { productId: r.cola, value: '3.00' });
    const res = await write(r.owner, 'patch', `/catalog/price-rules/${ok.id}`, {
      kind: 'percent_off',
    }).expect(400);
    expect(res.body).toMatchObject({ details: { problems: ['percent_on_product'] } });
    // Malformed fields fail validation; an unknown product, category or location is 404.
    await write(r.owner, 'post', '/catalog/price-rules', {
      name: 'X',
      kind: 'fixed',
      productId: r.cola,
      value: '1',
      startsAt: '25:00',
      endsAt: '26:00',
    }).expect(400);
    await write(r.owner, 'post', '/catalog/price-rules', {
      name: 'X',
      kind: 'fixed',
      productId: uuidv7(),
      value: '1',
    }).expect(404);
    await write(r.owner, 'post', '/catalog/price-rules', {
      name: 'X',
      kind: 'fixed',
      productId: r.cola,
      value: '1',
      locationId: uuidv7(),
    }).expect(404);
  });

  it('gives each location its price, with the happy hour on top at its hours', async () => {
    const r = await restaurant();
    const { happy } = await withRules(r);
    expect(await prices(r.owner, r.main)).toMatchObject({
      [r.cola]: '4.00',
      [r.beer]: '5.00',
      [r.soup]: '6.90',
    });
    expect(await prices(r.owner, r.harbour)).toMatchObject({ [r.cola]: '3.80' });

    clock.set(berlin('18:00'));
    const now = pricesResponseSchema.parse(
      (await get(r.owner, `/catalog/prices?locationId=${r.main}`).expect(200)).body,
    );
    expect(now.data.find((p) => p.productId === r.cola)).toEqual({
      productId: r.cola,
      price: '3.20',
      ruleId: happy.id,
      ruleName: 'Happy hour',
      timed: true,
    });
    expect(await prices(r.owner, r.harbour)).toMatchObject({
      [r.cola]: '3.04',
      [r.beer]: '4.00',
      [r.soup]: '6.90',
    });
    // Without time rules (margins) and at a chosen moment.
    expect(await prices(r.owner, r.main, '&timed=false')).toMatchObject({ [r.cola]: '4.00' });
    expect(await prices(r.owner, r.main, `&at=${berlin('20:00').toISOString()}`)).toMatchObject({
      [r.cola]: '4.00',
    });
    // Saturday: no happy hour.
    clock.set(berlin('18:00', '2026-11-07'));
    expect(await prices(r.owner, r.main)).toMatchObject({ [r.cola]: '4.00' });
  });

  it("uses the location's own time zone", async () => {
    const r = await restaurant();
    await withRules(r);
    // 18:00 in Berlin is 22:30 in Colombo: no happy hour at a location there.
    await write(r.owner, 'put', `/settings/timezone?locationId=${r.harbour}`, {
      value: 'Asia/Colombo',
    }).expect(200);
    clock.set(berlin('18:00'));
    expect(await prices(r.owner, r.harbour)).toMatchObject({ [r.cola]: '3.80' });
    // 13:00 in Berlin is 17:30 in Colombo.
    clock.set(berlin('13:00'));
    expect(await prices(r.owner, r.harbour)).toMatchObject({ [r.cola]: '3.04' });
  });

  it('charges the price of the moment items are sent; voids keep it', async () => {
    const r = await restaurant();
    await withRules(r);
    const send = async (lines: object[]) =>
      sendTicketResponseSchema.parse(
        (await write(r.owner, 'post', `/pos/tables/${r.table.id}/tickets`, { lines }).expect(201))
          .body,
      );
    clock.set(berlin('18:00'));
    const first = await send([{ productId: r.cola, quantity: 2 }]);
    clock.set(berlin('20:00'));
    const second = await send([{ productId: r.cola, quantity: 1 }]);
    const lines = second.order.tickets.flatMap((t) => t.lines);
    expect(lines.map((l) => [l.unitPrice, l.quantity])).toEqual([
      ['3.20', 2],
      ['4.00', 1],
    ]);
    expect(second.order.totals.gross).toBe('10.40');
    // Cancel one happy-hour cola after the happy hour: it goes back at 3.20.
    const happyLine = first.order.tickets[0]!.lines[0]!;
    const voided = await write(r.owner, 'post', `/pos/orders/${first.order.id}/voids`, {
      lines: [{ lineId: happyLine.id, quantity: 1 }],
    }).expect(201);
    const voidLine = (
      voided.body as { order: { tickets: { kind: string; lines: { unitPrice: string }[] }[] } }
    ).order.tickets.find((t) => t.kind === 'void')!.lines[0]!;
    expect(voidLine.unitPrice).toBe('3.20');
  });

  it("shows guests the price of the table's location on the QR menu", async () => {
    const r = await restaurant();
    await withRules(r);
    clock.set(berlin('18:00'));
    const menu = publicMenuSchema.parse(
      (await request(server).get(`/api/v1/public/menu/${r.org.id}.${r.table.menuCode}`).expect(200))
        .body,
    );
    const drinks = menu.categories.find((c) => c.name === 'Drinks')!;
    expect(drinks.products.map((p) => [p.name, p.price])).toEqual([
      ['Beer', '4.00'],
      ['Cola', '3.20'],
    ]);
  });

  it('ignores inactive rules and drops rules with their product', async () => {
    const r = await restaurant();
    const { mainCola } = await withRules(r);
    await write(r.owner, 'patch', `/catalog/price-rules/${mainCola.id}`, { active: false }).expect(
      200,
    );
    expect(await prices(r.owner, r.main)).toMatchObject({ [r.cola]: '3.80' });
    // Bulk delete of an unsold product still works; its rules go with it.
    await write(r.owner, 'post', '/catalog/products/bulk', {
      ids: [r.cola],
      action: { kind: 'delete' },
    }).expect(200);
    const left = priceRuleListResponseSchema.parse(
      (await get(r.owner, '/catalog/price-rules').expect(200)).body,
    );
    expect(left.data.map((x) => x.name)).toEqual(['Happy hour']);
  });

  it('needs catalog.products.manage to change rules and reading rights at the location for prices', async () => {
    const r = await restaurant();
    const waiter = await memberToken(r.org, 'waiter', [r.main]);
    await get(waiter, '/catalog/price-rules').expect(200);
    await write(waiter, 'post', '/catalog/price-rules', {
      name: 'X',
      kind: 'fixed',
      productId: r.cola,
      value: '1',
    }).expect(403);
    await get(waiter, `/catalog/prices?locationId=${r.main}`).expect(200);
    const outside = await get(waiter, `/catalog/prices?locationId=${r.harbour}`).expect(404);
    expect(outside.body).toMatchObject({ code: 'catalog.location_not_found' });
  });

  it("never sees or uses another organization's rules", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const { happy } = await withRules(a);
    const list = priceRuleListResponseSchema.parse(
      (await get(b.owner, '/catalog/price-rules').expect(200)).body,
    );
    expect(list.data).toEqual([]);
    await write(b.owner, 'patch', `/catalog/price-rules/${happy.id}`, { active: false }).expect(
      404,
    );
    await write(b.owner, 'post', '/catalog/price-rules', {
      name: 'X',
      kind: 'fixed',
      productId: a.cola,
      value: '1',
    }).expect(404);
    await get(b.owner, `/catalog/prices?locationId=${a.main}`).expect(404);
    clock.set(berlin('18:00'));
    expect(await prices(b.owner, b.main)).toMatchObject({ [b.cola]: '3.80' });
  });
});
