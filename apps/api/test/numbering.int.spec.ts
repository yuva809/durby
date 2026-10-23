import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NUMBER_SERIES_KEYS, type NumberSeriesKey } from '@durby/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { Clock } from '../src/platform/auth/clock';
import { type AllocatedNumber, NumberingService } from '../src/platform/numbering';
import { ProvisioningService } from '../src/platform/provisioning';
import { FakeClock } from './support/fake-clock';
import { RbacSeed } from './support/rbac';

/** docs/platform/numbering.md → Allocation: gap-free, consecutive, per tenant and period. */
describe('NumberingService.next', () => {
  let app: INestApplication;
  let seed: RbacSeed;
  let numbering: NumberingService;
  const clock = new FakeClock(new Date('2026-06-15T10:00:00Z'));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    seed = new RbacSeed(app);
    numbering = app.get(NumberingService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** One allocation in its own transaction of `orgId`, like a business write. */
  const allocate = (
    orgId: string,
    key: NumberSeriesKey = 'billing.invoice',
    opts: { at?: Date } = {},
  ): Promise<AllocatedNumber> =>
    seed.as(orgId, (db) => db.$transaction((tx) => numbering.next(key, tx, opts)));

  const parallel = (orgId: string, n: number) =>
    Promise.all(Array.from({ length: n }, () => allocate(orgId)));

  const sequences = (numbers: AllocatedNumber[]) =>
    numbers.map((n) => Number(n.sequence)).sort((a, b) => a - b);

  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  const setTimezone = (orgId: string, value: string) =>
    seed.as(orgId, (db) =>
      db.settingValue.create({
        data: { tenantId: orgId, scopeType: 'organization', key: 'timezone', value },
      }),
    );

  it('50 parallel allocations get 50 unique, consecutive numbers', async () => {
    const { id } = await seed.org();
    await allocate(id); // the series and counter exist: only the counter row is contended
    const numbers = await parallel(id, 50);
    expect(sequences(numbers)).toEqual(range(2, 50));
    expect(new Set(numbers.map((n) => n.number)).size).toBe(50);
    expect(numbers.find((n) => n.sequence === 2n)?.number).toBe('INV-2026-000002');
  });

  it('50 parallel first uses create the series and counter once, still 1 … 50', async () => {
    const { id } = await seed.org();
    const numbers = await parallel(id, 50);
    expect(sequences(numbers)).toEqual(range(1, 50));
    const rows = await seed.as(id, (db) =>
      db.numberSeriesCounter.findMany({ select: { period: true, nextValue: true } }),
    );
    expect(rows).toEqual([{ period: '2026', nextValue: 51n }]);
  });

  it('a rolled-back allocation leaves no gap', async () => {
    const { id } = await seed.org();
    await expect(
      seed.as(id, (db) =>
        db.$transaction(async (tx) => {
          await numbering.next('billing.invoice', tx);
          throw new Error('business write failed');
        }),
      ),
    ).rejects.toThrow('business write failed');
    expect((await allocate(id)).number).toBe('INV-2026-000001');
  });

  it('keeps series and periods apart', async () => {
    const { id } = await seed.org();
    await allocate(id, 'billing.invoice');
    expect((await allocate(id, 'inventory.goodsReceipt')).number).toBe('GR-2026-000001');
    expect((await allocate(id, 'billing.invoice')).number).toBe('INV-2026-000002');
  });

  describe('year in the organization time zone', () => {
    it('31 Dec 23:30 in Berlin still belongs to 2026', async () => {
      const { id } = await seed.org();
      const at = new Date('2026-12-31T22:30:00Z'); // 23:30 in Berlin (the default time zone)
      expect(await allocate(id, 'billing.invoice', { at })).toEqual({
        number: 'INV-2026-000001',
        period: '2026',
        sequence: 1n,
      });
    });

    it('31 Dec 23:30 UTC starts 2027 in Berlin at 1, but not in a UTC organization', async () => {
      const berlin = (await seed.org()).id;
      const utc = (await seed.org()).id;
      await setTimezone(utc, 'UTC');
      const before = new Date('2026-12-31T22:00:00Z');
      const at = new Date('2026-12-31T23:30:00Z');
      for (const org of [berlin, utc]) await allocate(org, 'billing.invoice', { at: before });

      expect(await allocate(berlin, 'billing.invoice', { at })).toEqual({
        number: 'INV-2027-000001',
        period: '2027',
        sequence: 1n,
      });
      expect((await allocate(utc, 'billing.invoice', { at })).number).toBe('INV-2026-000002');
    });

    it('uses the clock when no date is given', async () => {
      const { id } = await seed.org();
      clock.set(new Date('2027-01-01T00:15:00+01:00'));
      try {
        expect((await allocate(id)).period).toBe('2027');
      } finally {
        clock.set(new Date('2026-06-15T10:00:00Z'));
      }
    });
  });

  it('a series that never resets uses one counter across years', async () => {
    const { id } = await seed.org();
    await seed.as(id, async (db) => {
      await db.numberSeries.create({
        data: {
          tenantId: id,
          key: 'inventory.goodsReceipt',
          prefix: 'WE',
          pattern: '{prefix}{seq:5}',
          resetPolicy: 'never',
        },
      });
    });
    const first = await allocate(id, 'inventory.goodsReceipt', { at: new Date('2026-06-01Z') });
    const second = await allocate(id, 'inventory.goodsReceipt', { at: new Date('2027-06-01Z') });
    expect([first, second].map((n) => [n.number, n.period])).toEqual([
      ['WE00001', 'all'],
      ['WE00002', 'all'],
    ]);
  });

  it('refuses an unregistered key', async () => {
    const { id } = await seed.org();
    await expect(allocate(id, 'billing.creditNote' as NumberSeriesKey)).rejects.toThrow(
      'Unregistered number series: billing.creditNote',
    );
  });

  describe('cross-tenant isolation', () => {
    it("org A's allocations never affect org B", async () => {
      const a = (await seed.org()).id;
      const b = (await seed.org()).id;
      const [numbersA] = await Promise.all([
        parallel(a, 50),
        allocate(b, 'inventory.goodsReceipt'),
      ]);
      expect(sequences(numbersA)).toEqual(range(1, 50));
      expect((await allocate(b)).number).toBe('INV-2026-000001');

      const seenByB = await seed.as(b, (db) =>
        db.numberSeriesCounter.findMany({ select: { tenantId: true, nextValue: true } }),
      );
      expect(seenByB.every((row) => row.tenantId === b)).toBe(true);
      expect(seenByB.map((row) => row.nextValue).sort()).toEqual([2n, 2n]);
    });
  });

  it('provisioning creates every registered series with the registry defaults', async () => {
    const provisioning = app.get(ProvisioningService);
    const partner = await provisioning.ensurePartner(`p-${Date.now()}`, 'P');
    const org = await provisioning.ensureOrganization(partner.id, 'Numbered', 'cli.seed_dev');
    const series = await seed.as(org.id, (db) =>
      db.numberSeries.findMany({
        select: { key: true, prefix: true, pattern: true, resetPolicy: true },
        orderBy: { key: 'asc' },
      }),
    );
    expect(series.map((s) => s.key)).toEqual([...NUMBER_SERIES_KEYS].sort());
    expect(series.find((s) => s.key === 'billing.invoice')).toEqual({
      key: 'billing.invoice',
      prefix: 'INV',
      pattern: '{prefix}-{YYYY}-{seq:6}',
      resetPolicy: 'yearly',
    });
    // Idempotent: a second call creates nothing new and fails on nothing.
    await provisioning.ensureOrganization(partner.id, 'Numbered', 'cli.seed_dev');
    expect(await seed.as(org.id, (db) => db.numberSeries.count())).toBe(NUMBER_SERIES_KEYS.length);
  });
});
