import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { OutboxService, OutboxWakeup } from '../src/platform/outbox';
import { createOwnDatabase, useDatabase } from './support/own-database';
import { RbacSeed } from './support/rbac';

/**
 * ADR 0044 §5: the outbox worker wakes when an event commits (pg_notify in the event's insert,
 * LISTEN on the worker's own connection), not on its next idle pass (up to 5 s). Own database:
 * notifications are per database, and other files commit events on the shared one meanwhile.
 */
describe('outbox wake-up', () => {
  let app: INestApplication;
  let seed: RbacSeed;
  let outbox: OutboxService;
  let wakeup: OutboxWakeup;
  let wakes = 0;

  beforeAll(async () => {
    useDatabase(await createOwnDatabase('outbox_wakeup'));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    seed = new RbacSeed(app);
    outbox = app.get(OutboxService);
    wakeup = app.get(OutboxWakeup);
    await wakeup.listen(() => wakes++);
  });

  afterAll(async () => {
    await app.close();
  });

  const add = (orgId: string, rollback: boolean) =>
    seed.as(orgId, (db) =>
      db.$transaction(async (tx) => {
        await outbox.add(tx, {
          type: 'config.settings.changed',
          payload: { scope: 'organization', scopeId: orgId, key: 'timezone' },
        });
        // Still uncommitted: nothing is delivered before the commit.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(wakes).toBe(before);
        if (rollback) throw new Error('rolled back');
      }),
    );
  let before = 0;

  const settled = async (expected: number) => {
    for (let waited = 0; waited < 1_000 && wakes < expected; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return wakes;
  };

  it('wakes on commit, once per transaction', async () => {
    const org = await seed.org();
    before = wakes;
    await add(org.id, false);
    expect(await settled(before + 1)).toBe(before + 1);
  });

  it('stays asleep when the transaction rolls back', async () => {
    const org = await seed.org();
    before = wakes;
    await expect(add(org.id, true)).rejects.toThrow('rolled back');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes).toBe(before);
  });

  it('listens again after its connection drops', async () => {
    const org = await seed.org();
    await wakeup.dropConnectionForTest();
    await wakeup.listening();
    before = wakes;
    await add(org.id, false);
    expect(await settled(before + 1)).toBe(before + 1);
  });
});
