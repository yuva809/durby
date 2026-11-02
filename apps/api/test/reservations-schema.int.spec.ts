import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client, type DatabaseError } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { findAppendOnlyGaps } from './support/append-only';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * docs/modules/reservations.md → Entities, SQL; ADR 0019: the exclusion constraint makes double
 * booking impossible in the database, whatever the api does. Written as durby_app under RLS, with
 * raw SQL so constraint violations surface as their SQLSTATE.
 */
describe('reservations schema', () => {
  let app: INestApplication;
  let seed: RbacSeed;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    seed = new RbacSeed(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A durby_app connection inside one transaction of `tenantId` (RLS applies). */
  async function asTenant<T>(tenantId: string, fn: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: inject('databaseUrl') });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await db.end();
    }
  }

  interface Venue {
    org: SeededOrg;
    here: string;
    there: string;
    t1: string;
    t2: string;
    far: string;
    guest: string;
  }

  /** Two tables at the first location, one at the second, and a guest. */
  async function venue(): Promise<Venue> {
    const org = await seed.org();
    const [here, there] = org.locations;
    const table = (locationId: string, name: string) =>
      seed.as(org.id, async (db) => {
        const row = await db.diningTable.create({
          data: { tenantId: org.id, locationId, name, seats: 4 },
        });
        return row.id;
      });
    const t1 = await table(here, 'T1');
    const t2 = await table(here, 'T2');
    const far = await table(there, 'F1');
    const guest = await asTenant(org.id, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO reservation_guests (tenant_id, name, locale, updated_at)
         VALUES ($1, 'Ada', 'en', now()) RETURNING id`,
        [org.id],
      );
      return rows[0]!.id;
    });
    return { org, here, there, t1, t2, far, guest };
  }

  interface Booking {
    tables: string[];
    start: string;
    end: string;
    status?: string;
    locationId?: string;
  }

  /** A reservation with its table rows, in one transaction; returns its id. */
  async function book(v: Venue, b: Booking, db?: Client): Promise<string> {
    const run = async (c: Client) => {
      const locationId = b.locationId ?? v.here;
      const status = b.status ?? 'booked';
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO reservations
           (tenant_id, location_id, number, guest_id, party_size, starts_at, ends_at, status, source, updated_at)
         VALUES ($1, $2, $3, $4, 2, $5, $6, $7, 'staff', now()) RETURNING id`,
        [v.org.id, locationId, `RES-${uuidv7().slice(-12)}`, v.guest, b.start, b.end, status],
      );
      const id = rows[0]!.id;
      for (const table of b.tables) {
        await c.query(
          `INSERT INTO reservation_tables (tenant_id, reservation_id, location_id, table_id, period, blocking)
           VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'),
                   $7 IN ('pending', 'booked', 'arrived', 'seated'))`,
          [v.org.id, id, locationId, table, b.start, b.end, status],
        );
      }
      return id;
    };
    return db ? run(db) : asTenant(v.org.id, run);
  }

  const sqlState = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (error) {
      return (error as DatabaseError).code ?? String(error);
    }
  };

  const at = (hhmm: string) => `2026-11-14T${hhmm}:00Z`;

  describe('exclusion constraint (no double booking)', () => {
    it('refuses a second blocking booking of a table for an overlapping time', async () => {
      const v = await venue();
      await book(v, { tables: [v.t1], start: at('18:00'), end: at('20:00') });
      expect(
        await sqlState(book(v, { tables: [v.t1], start: at('19:00'), end: at('21:00') })),
      ).toBe('23P01');
      // Same time on another table is fine.
      await book(v, { tables: [v.t2], start: at('19:00'), end: at('21:00') });
    });

    it('lets turns touch: 18:00–20:00 then 20:00–22:00', async () => {
      const v = await venue();
      await book(v, { tables: [v.t1], start: at('18:00'), end: at('20:00') });
      await book(v, { tables: [v.t1], start: at('20:00'), end: at('22:00') });
    });

    it('blocks for pending, booked, arrived and seated; not for the other statuses', async () => {
      for (const status of ['pending', 'booked', 'arrived', 'seated']) {
        const v = await venue();
        await book(v, { tables: [v.t1], start: at('18:00'), end: at('20:00'), status });
        expect(
          await sqlState(book(v, { tables: [v.t1], start: at('18:30'), end: at('19:30') })),
          status,
        ).toBe('23P01');
      }
      for (const status of ['finished', 'no_show', 'cancelled', 'declined', 'expired']) {
        const v = await venue();
        await book(v, { tables: [v.t1], start: at('18:00'), end: at('20:00'), status });
        await book(v, { tables: [v.t1], start: at('18:30'), end: at('19:30') });
      }
    });

    it('refuses a combination when one of its tables is taken', async () => {
      const v = await venue();
      await book(v, { tables: [v.t2], start: at('19:00'), end: at('21:00') });
      expect(
        await sqlState(book(v, { tables: [v.t1, v.t2], start: at('20:00'), end: at('22:00') })),
      ).toBe('23P01');
    });

    it('refuses to re-block a cancelled booking whose table was taken meanwhile', async () => {
      const v = await venue();
      const first = await book(v, { tables: [v.t1], start: at('18:00'), end: at('20:00') });
      await asTenant(v.org.id, (db) =>
        db.query(`UPDATE reservations SET status = 'cancelled' WHERE id = $1`, [first]),
      );
      await book(v, { tables: [v.t1], start: at('18:30'), end: at('19:30') });
      expect(
        await sqlState(
          asTenant(v.org.id, (db) =>
            db.query(`UPDATE reservations SET status = 'booked' WHERE id = $1`, [first]),
          ),
        ),
      ).toBe('23P01');
    });

    it('lets exactly one of 20 concurrent bookings of the same table and time commit', async () => {
      const v = await venue();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          sqlState(book(v, { tables: [v.t1], start: at('19:00'), end: at('21:00') })),
        ),
      );
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.filter((r) => r === '23P01')).toHaveLength(19);
    });

    it("never compares tenants: another organization's rows don't block", async () => {
      const a = await venue();
      const b = await venue();
      await book(a, { tables: [a.t1], start: at('18:00'), end: at('20:00') });
      await book(b, { tables: [b.t1], start: at('18:00'), end: at('20:00') });
    });
  });

  describe('period and blocking follow the reservation (triggers)', () => {
    const rowsOf = (v: Venue, id: string) =>
      asTenant(v.org.id, async (db) => {
        const { rows } = await db.query<{ lo: Date; hi: Date; blocking: boolean }>(
          `SELECT lower(period) AS lo, upper(period) AS hi, blocking
           FROM reservation_tables WHERE reservation_id = $1 ORDER BY table_id`,
          [id],
        );
        return rows.map((r) => ({
          lo: r.lo.toISOString(),
          hi: r.hi.toISOString(),
          blocking: r.blocking,
        }));
      });

    it('moves the period and clears blocking with the reservation', async () => {
      const v = await venue();
      const id = await book(v, { tables: [v.t1, v.t2], start: at('18:00'), end: at('20:00') });
      await asTenant(v.org.id, (db) =>
        db.query(
          `UPDATE reservations SET starts_at = $2, ends_at = $3, status = 'seated' WHERE id = $1`,
          [id, at('18:30'), at('20:30')],
        ),
      );
      const moved = { lo: '2026-11-14T18:30:00.000Z', hi: '2026-11-14T20:30:00.000Z' };
      expect(await rowsOf(v, id)).toEqual([
        { ...moved, blocking: true },
        { ...moved, blocking: true },
      ]);
      await asTenant(v.org.id, (db) =>
        db.query(`UPDATE reservations SET status = 'finished' WHERE id = $1`, [id]),
      );
      expect((await rowsOf(v, id)).map((r) => r.blocking)).toEqual([false, false]);
    });

    it('refuses table rows that disagree with their reservation', async () => {
      const v = await venue();
      const id = await book(v, { tables: [], start: at('18:00'), end: at('20:00') });
      const insert = (period: [string, string], blocking: boolean, locationId = v.here) =>
        asTenant(v.org.id, (db) =>
          db.query(
            `INSERT INTO reservation_tables (tenant_id, reservation_id, location_id, table_id, period, blocking)
             VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $7)`,
            [v.org.id, id, locationId, v.t1, period[0], period[1], blocking],
          ),
        );
      expect(await sqlState(insert([at('18:00'), at('21:00')], true))).toBe('23514');
      expect(await sqlState(insert([at('18:00'), at('20:00')], false))).toBe('23514');
      await insert([at('18:00'), at('20:00')], true);
    });

    it('refuses a table of another location (composite foreign key)', async () => {
      const v = await venue();
      expect(
        await sqlState(book(v, { tables: [v.far], start: at('18:00'), end: at('20:00') })),
      ).toBe('23503');
    });

    it('refuses empty or backwards periods and impossible party sizes', async () => {
      const v = await venue();
      expect(await sqlState(book(v, { tables: [], start: at('20:00'), end: at('20:00') }))).toBe(
        '23514',
      );
      expect(await sqlState(book(v, { tables: [], start: at('21:00'), end: at('20:00') }))).toBe(
        '23514',
      );
      expect(
        await sqlState(
          asTenant(v.org.id, (db) =>
            db.query(
              `INSERT INTO reservations (tenant_id, location_id, number, guest_id, party_size, starts_at,
                 ends_at, status, source, updated_at)
               VALUES ($1, $2, 'RES-X', $3, 0, $4, $5, 'booked', 'staff', now())`,
              [v.org.id, v.here, v.guest, at('18:00'), at('20:00')],
            ),
          ),
        ),
      ).toBe('23514');
    });
  });

  describe('history and isolation', () => {
    it('keeps status changes append-only and reservations undeletable for durby_app', async () => {
      const admin = new Client({ connectionString: inject('migrationDatabaseUrl') });
      await admin.connect();
      try {
        expect(await findAppendOnlyGaps(admin, ['reservation_status_changes'])).toEqual([]);
        const { rows } = await admin.query<{ table: string; del: boolean }>(
          `SELECT t AS table, has_table_privilege('durby_app', t, 'DELETE') AS del
           FROM unnest(ARRAY['reservations', 'reservation_guests']) AS t ORDER BY t`,
        );
        expect(rows).toEqual([
          { table: 'reservation_guests', del: false },
          { table: 'reservations', del: false },
        ]);
      } finally {
        await admin.end();
      }
    });

    it('keeps one guest per email per organization while not anonymised', async () => {
      const v = await venue();
      const guest = (email: string, anonymised = false) =>
        asTenant(v.org.id, (db) =>
          db.query(
            `INSERT INTO reservation_guests (tenant_id, name, email, locale, anonymised_at, updated_at)
             VALUES ($1, 'G', $2, 'en', $3, now())`,
            [v.org.id, email, anonymised ? new Date() : null],
          ),
        );
      await guest('ada@example.test');
      expect(await sqlState(guest('ada@example.test'))).toBe('23505');
      expect(await sqlState(guest('Ada@Example.test'))).toBe('23514'); // stored lower-case only
      await guest('ada@example.test', true);
    });

    it('lets guests share a phone number, with a partial index for matching live guests', async () => {
      const v = await venue();
      const guest = (phone: string) =>
        asTenant(v.org.id, (db) =>
          db.query(
            `INSERT INTO reservation_guests (tenant_id, phone, locale, updated_at)
             VALUES ($1, $2, 'en', now())`,
            [v.org.id, phone],
          ),
        );
      await guest('+4917612345678');
      await guest('+4917612345678'); // a family: not unique
      expect(await sqlState(guest('0176 12345678'))).toBe('23514'); // E.164 only
      const index = await asTenant(v.org.id, (db) =>
        db.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'reservation_guests_live_phone_idx'`,
        ),
      );
      expect(index.rows[0]?.indexdef).toBe(
        'CREATE INDEX reservation_guests_live_phone_idx ON public.reservation_guests USING btree (tenant_id, phone) WHERE (anonymised_at IS NULL)',
      );
    });

    it("shows no organization another's reservations, tables or guests", async () => {
      const a = await venue();
      const b = await venue();
      await book(a, { tables: [a.t1], start: at('18:00'), end: at('20:00') });
      const counts = await asTenant(b.org.id, async (db) => {
        const count = async (table: string) =>
          Number(
            (
              await db.query<{ n: string }>(
                `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
                [a.org.id],
              )
            ).rows[0]!.n,
          );
        return {
          reservations: await count('reservations'),
          tables: await count('reservation_tables'),
          guests: await count('reservation_guests'),
        };
      });
      expect(counts).toEqual({ reservations: 0, tables: 0, guests: 0 });
      // And B can't write a row carrying A's tenant id (RLS WITH CHECK).
      expect(
        await sqlState(
          asTenant(b.org.id, (db) =>
            db.query(
              `INSERT INTO reservation_guests (tenant_id, name, locale, updated_at)
               VALUES ($1, 'Mallory', 'en', now())`,
              [a.org.id],
            ),
          ),
        ),
      ).toBe('42501');
    });
  });
});
