import { type INestApplication, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Job, Queue, Worker } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { APP_CONFIG, type AppConfig } from '../src/platform/config';
import {
  type HandlerJobData,
  handlerJobId,
  OnEvent,
  OutboxAdmin,
  OutboxCleanup,
  OutboxDispatcher,
  type OutboxEvent,
  OutboxEventRunner,
  OutboxLagReporter,
  OutboxPublisher,
  OutboxService,
} from '../src/platform/outbox';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TenantContext,
  type TenantTransactionClient,
} from '../src/platform/tenancy';
import { createOwnDatabase, useDatabase } from './support/own-database';
import { RbacSeed } from './support/rbac';

const QUEUE = 'durby-outbox';

/** Switches shared by the test handler and publisher. */
const control = {
  handlerFails: false,
  publishFails: false,
  /** Tenants a handler saw: from the context and from an RLS-filtered read. */
  seen: [] as { event: string; contextTenant: string; visibleTenants: string[] }[],
};

/** Test-only handler: its effect is one more outbox row in the event's tenant, in `tx`. */
@Injectable()
class EchoHandler {
  constructor(
    private readonly outbox: OutboxService,
    private readonly context: TenantContext,
  ) {}

  @OnEvent('config.settings.changed', { handler: 'test.echo' })
  async apply(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    const visible = await tx.outboxEvent.findMany({
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    control.seen.push({
      event: event.id,
      contextTenant: this.context.require().tenantId,
      visibleTenants: visible.map((v) => v.tenantId),
    });
    await this.outbox.add(tx, {
      type: 'config.labels.changed',
      payload: { locale: 'en', key: 'test.echo' },
    });
    if (control.handlerFails) throw new Error('handler failed after its write');
  }
}

@Injectable()
class FlakyPublisher extends OutboxPublisher {
  override publish(jobs: readonly HandlerJobData[]): Promise<void> {
    if (control.publishFails) return Promise.reject(new Error('redis down'));
    return super.publish(jobs);
  }
}

/**
 * docs/platform/outbox.md → Dispatcher, Handlers, Worker process, CLI (ADR 0013). Runs on its own
 * database: the backlog, lag and cleanup read every tenant, so on the shared database their
 * results and run time would depend on the other test files running in parallel.
 */
describe('outbox dispatch and handlers', () => {
  let app: INestApplication;
  let seed: RbacSeed;
  let outbox: OutboxService;
  let dispatcher: OutboxDispatcher;
  let runner: OutboxEventRunner;
  let queue: Queue<HandlerJobData>;
  let worker: Worker<HandlerJobData> | undefined;

  beforeAll(async () => {
    useDatabase(await createOwnDatabase('outbox_dispatch'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [EchoHandler],
    })
      .overrideProvider(OutboxPublisher)
      .useFactory({
        inject: [APP_CONFIG],
        factory: (config: AppConfig) => new FlakyPublisher(config),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    seed = new RbacSeed(app);
    outbox = app.get(OutboxService);
    dispatcher = app.get(OutboxDispatcher);
    runner = app.get(OutboxEventRunner);
    queue = new Queue<HandlerJobData>(QUEUE, {
      connection: { url: inject('redisUrl'), maxRetriesPerRequest: null },
    });
  });

  afterAll(async () => {
    await worker?.close();
    await queue.close();
    await app.close();
  });

  beforeEach(() => {
    control.handlerFails = false;
    control.publishFails = false;
    control.seen = [];
  });

  /** One committed config.settings.changed event in `orgId`; returns its id. */
  const emit = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.$transaction((tx) =>
        outbox.add(tx, {
          type: 'config.settings.changed',
          payload: { scope: 'organization', scopeId: orgId, key: 'timezone' },
        }),
      ),
    );

  const rows = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.outboxEvent.findMany({
        select: {
          id: true,
          type: true,
          attempts: true,
          lastError: true,
          availableAt: true,
          publishedAt: true,
          deadLetteredAt: true,
        },
        orderBy: { id: 'asc' },
      }),
    );

  /** The database clock (the dispatcher's `now()`), not the test process's. */
  const dbNow = async (orgId: string): Promise<number> => {
    const [row] = await seed.as(orgId, (db) => db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`);
    return row?.now.getTime() ?? Number.NaN;
  };

  /** Effects of test.echo in `orgId`. */
  const effects = async (orgId: string) =>
    (await rows(orgId)).filter((r) => r.type === 'config.labels.changed').length;

  const processed = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.processedEvent.findMany({ select: { handler: true, eventId: true } }),
    );

  const jobData = (orgId: string, eventId: string): HandlerJobData => ({
    eventId,
    tenantId: orgId,
    type: 'config.settings.changed',
    version: 1,
    payload: { scope: 'organization', scopeId: orgId, key: 'timezone' },
    occurredAt: new Date().toISOString(),
    handler: 'test.echo',
  });

  /** Waits until `job` is completed or failed (the worker runs in this process). */
  async function settled(jobId: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const job = await queue.getJob(jobId);
      const state = job ? await job.getState() : 'missing';
      if (state === 'completed' || state === 'failed') return state;
      await new Promise((r) => setTimeout(r, 25));
    }
    const job = await queue.getJob(jobId);
    throw new Error(
      `job ${jobId} did not settle: ${job ? await job.getState() : 'missing'} ${job?.failedReason ?? ''}`,
    );
  }

  function startWorker(): void {
    worker ??= new Worker<HandlerJobData>(
      QUEUE,
      (job: Job<HandlerJobData>) => runner.run(job.data),
      {
        connection: { url: inject('redisUrl'), maxRetriesPerRequest: null },
      },
    );
  }

  it('runs on its own database', async () => {
    const [row] = await app.get<PlatformPrismaClient>(PLATFORM_PRISMA).$queryRaw<
      { db: string }[]
    >`SELECT current_database() AS db`;
    expect(row?.db).toBe('durby_outbox_dispatch');
  });

  it('publishes one job per handler and marks the event published', async () => {
    const { id: org } = await seed.org();
    const event = await emit(org);
    expect(await dispatcher.dispatchTenant(org)).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
      deadLettered: 0,
    });
    const job = await queue.getJob(handlerJobId(event, 'test.echo'));
    expect(job?.data).toMatchObject({ eventId: event, tenantId: org, handler: 'test.echo' });
    expect((await rows(org))[0]?.publishedAt).toBeInstanceOf(Date);
    // Nothing left to claim.
    expect((await dispatcher.dispatchTenant(org)).claimed).toBe(0);
  });

  it('runs a handler once, in the event tenant, with its processed_events row', async () => {
    startWorker();
    const { id: org } = await seed.org();
    const other = await seed.org();
    await emit(other.id); // visible to nobody but `other`
    const event = await emit(org);
    await dispatcher.dispatchTenant(org);
    expect(await settled(handlerJobId(event, 'test.echo'))).toBe('completed');

    expect(await effects(org)).toBe(1);
    expect(await processed(org)).toEqual([{ handler: 'test.echo', eventId: event }]);
    // Jobs left by earlier tests may run too once the worker starts: look at this event only.
    expect(control.seen.filter((s) => s.event === event)).toEqual([
      { event, contextTenant: org, visibleTenants: [org] },
    ]);
  });

  it('applies a handler once even if delivered twice, one after the other and concurrently', async () => {
    const { id: org } = await seed.org();
    const first = await emit(org);
    expect(await runner.run(jobData(org, first))).toBe('applied');
    expect(await runner.run(jobData(org, first))).toBe('duplicate');

    const second = await emit(org);
    const outcomes = await Promise.all([
      runner.run(jobData(org, second)),
      runner.run(jobData(org, second)),
    ]);
    expect(outcomes.sort()).toEqual(['applied', 'duplicate']);
    expect(await effects(org)).toBe(2);
  });

  it('applies once when the dispatcher publishes the same event again', async () => {
    startWorker();
    const { id: org } = await seed.org();
    const event = await emit(org);
    await dispatcher.dispatchTenant(org);
    const jobId = handlerJobId(event, 'test.echo');
    expect(await settled(jobId)).toBe('completed');

    // Lost commit after enqueueing: the event is pending again, and its job is gone from Redis.
    await seed.as(
      org,
      (db) =>
        db.$executeRaw`UPDATE outbox_events SET published_at = NULL WHERE id = ${event}::uuid`,
    );
    await queue.remove(jobId);
    await dispatcher.dispatchTenant(org);
    expect(await settled(jobId)).toBe('completed');
    expect(await effects(org)).toBe(1);
  });

  it('rolls back a failing handler: neither its effect nor its processed_events row', async () => {
    const { id: org } = await seed.org();
    const event = await emit(org);
    control.handlerFails = true;
    await expect(runner.run(jobData(org, event))).rejects.toThrow('handler failed');
    expect(await effects(org)).toBe(0);
    expect(await processed(org)).toEqual([]);

    control.handlerFails = false;
    expect(await runner.run(jobData(org, event))).toBe('applied');
    expect(await effects(org)).toBe(1);
  });

  it('backs off when Redis fails and dead-letters after the last attempt', async () => {
    const { id: org } = await seed.org();
    await emit(org);
    control.publishFails = true;
    const before = await dbNow(org);
    expect(await dispatcher.dispatchTenant(org)).toMatchObject({ claimed: 1, failed: 1 });
    const after = await dbNow(org);
    const [failed] = await rows(org);
    expect(failed).toMatchObject({ attempts: 1, lastError: 'redis down', publishedAt: null });
    // dispatchBackoffMs(1) = 2 s ± 20 % after the claim's now(), all on the database clock
    // (± 1 ms: timestamps reach JS truncated to milliseconds).
    const availableAt = failed?.availableAt.getTime() ?? Number.NaN;
    expect(availableAt).toBeGreaterThanOrEqual(before + 1600 - 1);
    expect(availableAt).toBeLessThanOrEqual(after + 2400 + 1);
    // In backoff: not claimed. Pushed out explicitly, since 1.6 s can pass on a slow run.
    await seed.as(
      org,
      (db) => db.$executeRaw`UPDATE outbox_events SET available_at = now() + interval '1 hour'`,
    );
    expect((await dispatcher.dispatchTenant(org)).claimed).toBe(0);

    const max = app.get<AppConfig>(APP_CONFIG).OUTBOX_MAX_ATTEMPTS;
    await seed.as(
      org,
      (db) => db.$executeRaw`UPDATE outbox_events SET attempts = ${max - 1}, available_at = now()`,
    );
    expect(await dispatcher.dispatchTenant(org)).toMatchObject({ failed: 1, deadLettered: 1 });
    const [dead] = await rows(org);
    expect(dead?.deadLetteredAt).toBeInstanceOf(Date);
    expect((await dispatcher.dispatchTenant(org)).claimed).toBe(0);
  });

  it('leaves events of types this release does not know pending (rollback safety)', async () => {
    const { id: org } = await seed.org();
    const before = await dispatcher.backlogTotals();
    await seed.as(
      org,
      (db) =>
        db.$executeRaw`INSERT INTO outbox_events (tenant_id, type, version, payload)
        VALUES (${org}::uuid, 'future.thing.happened', 1, '{}')`,
    );
    expect((await dispatcher.dispatchTenant(org)).claimed).toBe(0);
    expect((await rows(org))[0]?.publishedAt).toBeNull();
    // Not a due tenant (no claim slot), but still counted by the lag (this file's own database).
    expect((await dispatcher.dueTenants()).some((t) => t.tenantId === org)).toBe(false);
    const after = await dispatcher.backlogTotals();
    expect(after.pending - before.pending).toBe(1);
    expect(after.due - before.due).toBe(0);
  });

  it('two dispatchers claim disjoint events (SKIP LOCKED), each published once', async () => {
    const { id: org } = await seed.org();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await emit(org));
    // The worker started by earlier tests would run these jobs as soon as they are enqueued, and
    // test.echo writes a new pending event into `org` that a dispatcher could then claim too.
    await worker?.pause();
    try {
      const [a, b] = await Promise.all([
        dispatcher.dispatchTenant(org),
        dispatcher.dispatchTenant(org),
      ]);
      expect((a?.claimed ?? 0) + (b?.claimed ?? 0)).toBe(20);
    } finally {
      void worker?.resume();
    }
    const emitted = (await rows(org)).filter((r) => ids.includes(r.id));
    expect(emitted).toHaveLength(20);
    expect(emitted.every((r) => r.publishedAt !== null)).toBe(true);
    const jobs = await Promise.all(ids.map((id) => queue.getJob(handlerJobId(id, 'test.echo'))));
    expect(jobs.filter(Boolean)).toHaveLength(20);
  });

  it('reports the backlog for the lag log', async () => {
    const { id: org } = await seed.org();
    const event = await emit(org);
    const [row] = await seed.as(org, (db) =>
      db.outboxEvent.findMany({ where: { id: event }, select: { occurredAt: true } }),
    );
    // Measured from the event's own (database) time, not the test process's clock.
    const now = new Date((row?.occurredAt.getTime() ?? Number.NaN) + 120_000);
    const lag = await app.get(OutboxLagReporter).measure(now);
    expect(lag.due).toBeGreaterThanOrEqual(1);
    expect(lag.oldestPendingSeconds).toBeGreaterThanOrEqual(120);
  });

  describe('delayed events (R2.0)', () => {
    /** An event in `orgId` that becomes due `inMs` after the database's now. */
    const emitAt = async (orgId: string, inMs: number) => {
      const at = new Date((await dbNow(orgId)) + inMs);
      return seed.as(orgId, (db) =>
        db.$transaction((tx) =>
          outbox.add(
            tx,
            {
              type: 'config.settings.changed',
              payload: { scope: 'organization', scopeId: orgId, key: 'timezone' },
            },
            { availableAt: at },
          ),
        ),
      );
    };
    const published = async (orgId: string, id: string) =>
      (await rows(orgId)).find((r) => r.id === id)?.publishedAt ?? null;

    it('is not claimed before its time, and is claimed after it', async () => {
      const { id: org } = await seed.org();
      const later = await emitAt(org, 2_000);
      const now = await emit(org);
      await dispatcher.dispatchTenant(org);
      expect(await published(org, now)).not.toBeNull();
      expect(await published(org, later)).toBeNull();
      // Due by the database's clock: wait until it has passed.
      const due = (await rows(org)).find((r) => r.id === later)!.availableAt.getTime();
      while ((await dbNow(org)) < due) await new Promise((r) => setTimeout(r, 100));
      await dispatcher.dispatchTenant(org);
      expect(await published(org, later)).not.toBeNull();
    });

    it('takes a time in the past as now', async () => {
      const { id: org } = await seed.org();
      const event = await emitAt(org, -3_600_000);
      const row = (await rows(org)).find((r) => r.id === event)!;
      expect(row.availableAt.getTime()).toBeGreaterThanOrEqual((await dbNow(org)) - 60_000);
      await dispatcher.dispatchTenant(org);
      expect(await published(org, event)).not.toBeNull();
    });

    it('counts a future event as pending, never as due or lag', async () => {
      const { id: org } = await seed.org();
      const at = new Date((await dbNow(org)) + 120_000);
      const before = await app.get(OutboxLagReporter).measure(at);
      await emitAt(org, 24 * 3_600_000);
      const after = await app.get(OutboxLagReporter).measure(at);
      expect(after.pending).toBe(before.pending + 1);
      expect(after.due).toBe(before.due);
      expect(after.oldestPendingSeconds).toBe(before.oldestPendingSeconds);
      // A tenant with only future events is not offered for dispatch.
      expect((await dispatcher.dueTenants()).map((t) => t.tenantId)).not.toContain(org);
    });

    it('measures lag from when an event became due', async () => {
      const { id: org } = await seed.org();
      const event = await emitAt(org, 1_000);
      const due = (await rows(org)).find((r) => r.id === event)!.availableAt.getTime();
      while ((await dbNow(org)) < due) await new Promise((r) => setTimeout(r, 100));
      const [tenant] = (await dispatcher.dueTenants()).filter((t) => t.tenantId === org);
      expect(tenant?.oldestPendingAt?.getTime()).toBe(due);
    });
  });

  it('cleans up published events and old processed rows, keeps pending and dead-lettered', async () => {
    const { id: org } = await seed.org();
    const published = await emit(org);
    const pending = await emit(org);
    const dead = await emit(org);
    await seed.as(org, async (db) => {
      await db.$executeRaw`UPDATE outbox_events SET published_at = now() - interval '8 days'
        WHERE id = ${published}::uuid`;
      await db.$executeRaw`UPDATE outbox_events SET dead_lettered_at = now() - interval '60 days'
        WHERE id = ${dead}::uuid`;
      await db.$executeRaw`INSERT INTO processed_events (tenant_id, handler, event_id, processed_at)
        VALUES (${org}::uuid, 'test.old', ${uuidv7()}::uuid, now() - interval '31 days'),
               (${org}::uuid, 'test.recent', ${uuidv7()}::uuid, now() - interval '1 day')`;
    });
    await app.get(OutboxCleanup).runOnce();
    expect((await rows(org)).map((r) => r.id)).toEqual([pending, dead]);
    expect((await processed(org)).map((p) => p.handler)).toEqual(['test.recent']);
  });

  describe('CLI operations', () => {
    it('lists and retries a dead-lettered event, audited', async () => {
      const admin = app.get(OutboxAdmin);
      const { id: org } = await seed.org();
      const event = await emit(org);
      await seed.as(
        org,
        (db) =>
          db.$executeRaw`UPDATE outbox_events SET attempts = 10, last_error = 'redis down',
          dead_lettered_at = now() WHERE id = ${event}::uuid`,
      );
      expect(await admin.deadLetters(org)).toMatchObject([
        { id: event, organizationId: org, attempts: 10, lastError: 'redis down' },
      ]);
      await admin.retry(org, event);
      expect((await rows(org))[0]).toMatchObject({
        attempts: 0,
        deadLetteredAt: null,
        lastError: null,
      });
      await expect(admin.retry(org, event)).rejects.toThrow('No dead-lettered event');
      const audit = await seed.as(org, (db) =>
        db.auditLog.findMany({ where: { action: 'platform.outbox_event.retried' } }),
      );
      expect(audit).toMatchObject([
        {
          actorSystem: 'cli.outbox',
          entityType: 'outbox_event',
          entityId: event,
          before: { id: event, attempts: 10, type: 'config.settings.changed' },
          after: { id: event, attempts: 0, deadLetteredAt: null },
        },
      ]);
    });

    it('lists and retries a handler job that exhausted its retries', async () => {
      startWorker();
      const admin = app.get(OutboxAdmin);
      const { id: org } = await seed.org();
      const event = await emit(org);
      const jobId = handlerJobId(event, 'test.echo');
      control.handlerFails = true;
      await queue.add('config.settings.changed', jobData(org, event), { jobId, attempts: 1 });
      expect(await settled(jobId)).toBe('failed');
      expect((await admin.handlerFailures()).find((f) => f.jobId === jobId)).toMatchObject({
        eventId: event,
        organizationId: org,
        handler: 'test.echo',
        failedReason: 'handler failed after its write',
      });

      control.handlerFails = false;
      await admin.retryHandler(jobId);
      expect(await settled(jobId)).toBe('completed');
      expect(await effects(org)).toBe(1);
      const audit = await seed.as(org, (db) =>
        db.auditLog.findMany({ where: { action: 'platform.outbox_event.retried' } }),
      );
      expect(audit).toMatchObject([{ entityId: event, after: { handler: 'test.echo' } }]);
    });
  });

  it('refuses to boot with an invalid handler', async () => {
    @Injectable()
    class BadHandler {
      @OnEvent('config.settings.changed', { handler: 'Bad Handler' })
      apply(): Promise<void> {
        return Promise.resolve();
      }
    }
    @Module({ providers: [BadHandler] })
    class BadModule {}
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, BadModule] }).compile();
    const bad = moduleRef.createNestApplication();
    await expect(bad.init()).rejects.toThrow('handler name must be module.camelCaseName');
    await bad.close();
  });
});
