import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { diningTableSchema, reservationSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { PrismaService } from '../src/platform/database';
import { TENANT_PRISMA, TenantContext } from '../src/platform/tenancy';
import { createTenantPrismaClient } from '../src/platform/tenancy/prisma-clients';
import { RbacSeed } from './support/rbac';

/**
 * docs/modules/reservations.md → R1.7b, ADR 0021: a booking request checks out few pooled
 * connections. Every database transaction a request opens starts with the tenant's set_config, so
 * counting those (for the request's own user: outbox jobs run as the system user) counts them all;
 * the bearer token's revocation check reads Redis, not the database.
 */
describe('reservations: transactions per request', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;
  /** The user of each transaction the api started (tenant set_config), in order. */
  const transactions: (string | undefined)[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TENANT_PRISMA)
      .useFactory({
        inject: [PrismaService, TenantContext],
        factory: (prisma: PrismaService, context: TenantContext) =>
          createTenantPrismaClient(
            prisma.$extends({
              query: {
                $allOperations({ model, args, query }) {
                  if (!model && isTenantSetConfig(args)) transactions.push(context.get()?.userId);
                  return query(args);
                },
              },
            }) as unknown as PrismaService,
            context,
          ),
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  /** The transactions `userId` opened while `fn` ran. */
  async function counted(userId: string, fn: () => Promise<unknown>): Promise<number> {
    const from = transactions.length;
    await fn();
    return transactions.slice(from).filter((user) => user === userId).length;
  }

  // Each write: guards (entitlements + membership) 1, idempotency claim 1, the write itself 1.
  it('creates and cancels a booking and seats a walk-in in 3 transactions each, edits in 4', async () => {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'full', 'cli.entitlements');
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles.owner);
    const token = await seed.token(userId, org.id);
    const [here] = org.locations;
    const send = (method: 'post' | 'patch', path: string, body: object = {}) =>
      request(server)
        [method](`/api/v1${path}`)
        .set('Idempotency-Key', uuidv7())
        .auth(token, { type: 'bearer' })
        .send(body);
    const tableIds: string[] = [];
    for (const name of ['T2', 'T4']) {
      tableIds.push(
        diningTableSchema.parse(
          (await send('post', '/pos/tables', { locationId: here, name, seats: 4 }).expect(201))
            .body,
        ).id,
      );
    }
    const booking = {
      locationId: here,
      startsAt: '2027-03-06T19:00:00+01:00',
      partySize: 2,
      guest: { name: 'Ada' },
    };

    let id = '';
    expect(
      await counted(userId, async () => {
        id = reservationSchema.parse(
          (await send('post', '/reservations', booking).expect(201)).body,
        ).id;
      }),
    ).toBe(3);
    expect(
      await counted(userId, () =>
        send('patch', `/reservations/${id}`, {
          startsAt: '2027-03-06T19:30:00+01:00',
          guest: { name: 'Ada', phone: '030 1234567' },
        }).expect(200),
      ),
      // PATCH completes its key after the write (plain @Idempotent()): one more, until ADR 0014
      // changes.
    ).toBe(4);
    expect(
      await counted(userId, () => send('post', `/reservations/${id}/cancel`).expect(201)),
    ).toBe(3);
    expect(
      await counted(userId, () =>
        send('post', '/reservations/walk-ins', {
          locationId: here,
          partySize: 2,
          tableIds: [tableIds[1]],
        }).expect(201),
      ),
    ).toBe(3);
  });
});

/** `SELECT set_config('app.tenant_id', …)`: the first statement of every tenant transaction. */
function isTenantSetConfig(args: unknown): boolean {
  const first: unknown = Array.isArray(args) ? args[0] : args;
  const strings = Array.isArray(first) ? first : (first as { strings?: unknown } | null)?.strings;
  return Array.isArray(strings) && strings.join('?').includes("set_config('app.tenant_id'");
}
